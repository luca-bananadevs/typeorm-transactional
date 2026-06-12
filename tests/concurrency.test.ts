import { DataSource } from 'typeorm';
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
  Propagation,
  runInTransaction,
  StorageDriver,
} from '../src';

import { User } from './entities/User.entity';
import { Counter } from './entities/Counter.entity';

const port = Number(process.env.TEST_PG_PORT ?? 5435);
const databaseName = 'test_concurrency';

const dataSource: DataSource = new DataSource({
  type: 'postgres',
  host: 'localhost',
  port,
  username: 'postgres',
  password: 'postgres',
  database: databaseName,
  entities: [User, Counter],
  synchronize: true,
});

const storageDriver =
  process.env.TEST_STORAGE_DRIVER && process.env.TEST_STORAGE_DRIVER in StorageDriver
    ? StorageDriver[process.env.TEST_STORAGE_DRIVER as keyof typeof StorageDriver]
    : StorageDriver.CLS_HOOKED;

initializeTransactionalContext({ storageDriver });

addTransactionalDataSource(dataSource);

beforeAll(async () => {
  // Jest runs test files in parallel workers and the shared "test" database is
  // dropped/synchronized by other suites, so this file uses its own database.
  const bootstrapDataSource = new DataSource({
    type: 'postgres',
    host: 'localhost',
    port,
    username: 'postgres',
    password: 'postgres',
    database: 'test',
  });

  await bootstrapDataSource.initialize();

  const found = await bootstrapDataSource.query(
    `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`,
  );
  if (found.length === 0) {
    await bootstrapDataSource.query(`CREATE DATABASE "${databaseName}"`);
  }

  await bootstrapDataSource.destroy();

  await dataSource.initialize();
});

afterAll(async () => {
  await dataSource.destroy();
});

// `txid_current()` assigns (and from then on returns) the txid of the transaction
// the query runs in. The patched `dataSource.query` routes the statement through
// the EntityManager currently held in the transactional context, so this tells us
// which transaction the current flow is actually attached to. If the context got
// corrupted and no manager is set, each call runs in its own autocommit
// transaction and returns a fresh txid — which also fails the assertions below.
const getTransactionId = async (): Promise<string> => {
  const result = await dataSource.query('SELECT txid_current() AS txid');
  return result[0].txid as string;
};

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// Repro for issue #15: the ASYNC_LOCAL_STORAGE driver
// (src/storage/driver/async-local-storage/index.ts) passes ONE shared mutable
// `Store` object into every nested `context.run()`. Its `enter()`/`exit()`
// methods mutate the single shared `storage` field through a `layers` stack that
// assumes strictly LIFO nesting. Concurrent sibling flows forked from the same
// parent context interleave `enter()`/`exit()` and `set()` calls on that shared
// object, so the "current" storage map is simply the last one entered: siblings
// steal each other's EntityManager and accidentally JOIN the same transaction
// instead of getting their own.
//
// The bug only manifests with ASYNC_LOCAL_STORAGE — CLS_HOOKED keeps a context
// per async execution path, so the assertions hold there. The test is therefore
// declared with `it.failing` only for the ALS driver; issue #17 (the ALS storage
// rewrite with immutable per-`run` stores) will flip it back to a plain `it`.
const maybeFailing = storageDriver === StorageDriver.ASYNC_LOCAL_STORAGE ? it.failing : it;

describe('Concurrent sibling flows forked from one parent transactional context', () => {
  // Run the sibling pair several times: a single pass could, with lucky
  // scheduling, avoid the corrupting interleaving. Any corrupted iteration
  // must fail the test.
  const ITERATIONS = 10;

  // Each sibling reads its txid several times, yielding to the event loop in
  // between, so the two flows are forced to interleave their reads and writes
  // on the shared Store.
  const READS_PER_SIBLING = 3;

  maybeFailing(
    'gives each REQUIRES_NEW sibling its own stable transaction, distinct from the parent',
    async () => {
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        await runInTransaction(async () => {
          const parentTxId = await getTransactionId();

          const runSibling = (): Promise<string[]> =>
            runInTransaction(
              async () => {
                const txIds: string[] = [];

                for (let read = 0; read < READS_PER_SIBLING; read++) {
                  txIds.push(await getTransactionId());

                  // Force interleaving with the other sibling between reads.
                  await yieldToEventLoop();
                }

                return txIds;
              },
              { propagation: Propagation.REQUIRES_NEW },
            );

          const [txIdsA, txIdsB] = await Promise.all([runSibling(), runSibling()]);

          // Each sibling must stay on the same transaction for its whole flow
          // (no EntityManager swap mid-flight).
          expect(new Set(txIdsA).size).toBe(1);
          expect(new Set(txIdsB).size).toBe(1);

          // REQUIRES_NEW siblings must be in different transactions from each
          // other and from the parent.
          expect(txIdsA[0]).not.toBe(txIdsB[0]);
          expect(txIdsA[0]).not.toBe(parentTxId);
          expect(txIdsB[0]).not.toBe(parentTxId);
        });
      }
    },
    30000,
  );
});
