/**
 * Characterization matrix — fork issue #2.
 *
 * This suite photographs the CURRENT behavior of `main` (propagation x hooks x error paths),
 * including known-wrong behavior, as the safety net for the M1 rewrites. Every assertion below
 * was discovered empirically (run first, asserted after) with BOTH storage drivers
 * (ASYNC_LOCAL_STORAGE and CLS_HOOKED); the two drivers do not diverge on any pinned case.
 * Concurrent sibling flows are deliberately out of scope here (see fork issue #15).
 *
 * | #  | Case                                          | Current behavior                                                          | Changes in |
 * |----|-----------------------------------------------|---------------------------------------------------------------------------|------------|
 * | 1  | REQUIRED, no active tx                        | creates a new tx; commits on success; no tx outside the block             | —          |
 * | 2  | REQUIRED inside REQUIRED                      | joins the outer tx (same txid)                                            | —          |
 * | 3  | REQUIRED, body throws                         | tx rolled back (row absent), error rethrown                               | —          |
 * | 4  | REQUIRES_NEW inside tx (sequential)           | new independent tx (different txid); outer manager restored afterwards    | —          |
 * | 5  | REQUIRES_NEW inner commit, outer rolls back   | inner row survives, outer row gone                                        | —          |
 * | 6  | REQUIRES_NEW inner throws (caught in outer)   | only inner rolled back; outer manager intact, outer commits               | —          |
 * | 7  | NESTED inside an active tx                    | WRONG: full new tx, identical to REQUIRES_NEW (different txid)            | #6         |
 * | 8  | NESTED inner commit, outer rolls back         | WRONG: inner row survives outer rollback (no SAVEPOINT)                   | #6         |
 * | 9  | NESTED inner throws (caught in outer)         | only inner discarded; outer commits (same outcome as future SAVEPOINT)    | #6 (mech.) |
 * | 10 | NOT_SUPPORTED inside tx, normal completion    | body runs without tx (no txid, writes durable); outer manager restored    | —          |
 * | 11 | NOT_SUPPORTED inside tx, body throws          | NOT PINNED: suspended manager is not restored (no try/finally) — broken   | #4         |
 * | 12 | commit hook timing                            | does NOT fire before the caller continuation; only after macrotask flush  | #18        |
 * | 13 | hook registered inside a JOINED tx            | does NOT throw (despite #5's text): the outer tx emitter is visible via   | #5         |
 * |    | (REQUIRED inside REQUIRED)                    | the context store copy; the hook fires exactly once, on outer commit      |            |
 * | 14 | rollback hook on throw                        | receives the thrown error, but only after a macrotask flush               | #18        |
 */
import { DataSource } from 'typeorm';
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
  Propagation,
  runInTransaction,
  runOnTransactionCommit,
  runOnTransactionRollback,
  StorageDriver,
} from '../src';

import { User } from './entities/User.entity';
import { Counter } from './entities/Counter.entity';

import { getCurrentTransactionId } from './utils';

const port = Number(process.env.TEST_PG_PORT ?? 5435);
const databaseName = 'test_characterization';

const dataSource = new DataSource({
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
  // Jest runs test files in parallel workers, so this file uses its own database instead of
  // the shared `test` database (which simple.test.ts synchronizes/clears concurrently).
  const bootstrap = new DataSource({
    type: 'postgres',
    host: 'localhost',
    port,
    username: 'postgres',
    password: 'postgres',
    database: 'test',
  });
  await bootstrap.initialize();
  const existing = await bootstrap.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    databaseName,
  ]);
  if (existing.length === 0) {
    await bootstrap.query(`CREATE DATABASE ${databaseName}`);
  }
  await bootstrap.destroy();

  await dataSource.initialize();
});

afterAll(async () => {
  await dataSource.destroy();
});

afterEach(async () => {
  await dataSource.createEntityManager().clear(User);
  await dataSource.createEntityManager().clear(Counter);
});

const findUser = (name: string) => dataSource.getRepository(User).findOneBy({ name });
const createUser = (name: string) => dataSource.getRepository(User).save(new User(name, 0));
const flushMacrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('Characterization of current behavior (fork issue #2)', () => {
  describe('Propagation.REQUIRED', () => {
    it('creates a new transaction when none is active and commits it', async () => {
      let transactionIdInside: number | null = null;

      await runInTransaction(
        async () => {
          transactionIdInside = await getCurrentTransactionId(dataSource);
          await createUser('required-new');
        },
        { propagation: Propagation.REQUIRED },
      );

      expect(transactionIdInside).toBeTruthy();

      // No transaction outside the block, and the write was committed
      const transactionIdOutside = await getCurrentTransactionId(dataSource);
      expect(transactionIdOutside).toBe(null);
      expect(await findUser('required-new')).toEqual(new User('required-new', 0));
    });

    it('joins the active transaction (same txid in the nested call)', async () => {
      let outerTransactionId: number | null = null;
      let innerTransactionId: number | null = null;

      await runInTransaction(async () => {
        outerTransactionId = await getCurrentTransactionId(dataSource);

        await runInTransaction(
          async () => {
            innerTransactionId = await getCurrentTransactionId(dataSource);
          },
          { propagation: Propagation.REQUIRED },
        );
      });

      expect(outerTransactionId).toBeTruthy();
      expect(innerTransactionId).toBe(outerTransactionId);
    });

    it('rolls back the transaction when the body throws (row absent, error rethrown)', async () => {
      await expect(
        runInTransaction(
          async () => {
            await createUser('required-rollback');
            throw new Error('required-boom');
          },
          { propagation: Propagation.REQUIRED },
        ),
      ).rejects.toThrow('required-boom');

      expect(await findUser('required-rollback')).toBe(null);
    });
  });

  describe('Propagation.REQUIRES_NEW', () => {
    // NOTE: the inner transaction here is always called SEQUENTIALLY from inside the outer one.
    // Concurrent sibling REQUIRES_NEW flows corrupt the ALS context — that pathological case is
    // pinned separately in fork issue #15.
    it('opens a new independent transaction and restores the outer manager afterwards', async () => {
      let outerTransactionId: number | null = null;
      let innerTransactionId: number | null = null;
      let outerTransactionIdAfter: number | null = null;

      await runInTransaction(async () => {
        outerTransactionId = await getCurrentTransactionId(dataSource);

        await runInTransaction(
          async () => {
            innerTransactionId = await getCurrentTransactionId(dataSource);
          },
          { propagation: Propagation.REQUIRES_NEW },
        );

        outerTransactionIdAfter = await getCurrentTransactionId(dataSource);
      });

      expect(outerTransactionId).toBeTruthy();
      expect(innerTransactionId).toBeTruthy();
      expect(innerTransactionId).not.toBe(outerTransactionId);
      expect(outerTransactionIdAfter).toBe(outerTransactionId);
    });

    it('inner commit survives outer rollback', async () => {
      try {
        await runInTransaction(async () => {
          await createUser('requires-new-outer');

          await runInTransaction(
            async () => {
              await createUser('requires-new-inner');
            },
            { propagation: Propagation.REQUIRES_NEW },
          );

          throw new Error('outer rollback');
        });
      } catch {}

      expect(await findUser('requires-new-outer')).toBe(null);
      expect(await findUser('requires-new-inner')).toEqual(new User('requires-new-inner', 0));
    });

    it('inner throw (caught in the outer) rolls back only the inner transaction', async () => {
      let outerTransactionId: number | null = null;
      let outerTransactionIdAfter: number | null = null;

      await runInTransaction(async () => {
        outerTransactionId = await getCurrentTransactionId(dataSource);
        await createUser('requires-new-outer-commits');

        try {
          await runInTransaction(
            async () => {
              await createUser('requires-new-inner-throws');
              throw new Error('inner rollback');
            },
            { propagation: Propagation.REQUIRES_NEW },
          );
        } catch {}

        outerTransactionIdAfter = await getCurrentTransactionId(dataSource);
      });

      // The outer transaction is not rolled back and its manager stays intact
      expect(outerTransactionIdAfter).toBe(outerTransactionId);
      expect(await findUser('requires-new-outer-commits')).toEqual(
        new User('requires-new-outer-commits', 0),
      );
      expect(await findUser('requires-new-inner-throws')).toBe(null);
    });
  });

  describe('Propagation.NESTED', () => {
    // NESTED is currently implemented identically to REQUIRES_NEW (full new transaction on a
    // separate connection) instead of a SAVEPOINT in the parent transaction.
    it('currently opens a full new transaction, like REQUIRES_NEW (different txid)', async () => {
      // CHARACTERIZATION: wrong, will change in #6 (real SAVEPOINT: same txid as the parent)
      let outerTransactionId: number | null = null;
      let innerTransactionId: number | null = null;
      let outerTransactionIdAfter: number | null = null;

      await runInTransaction(async () => {
        outerTransactionId = await getCurrentTransactionId(dataSource);

        await runInTransaction(
          async () => {
            innerTransactionId = await getCurrentTransactionId(dataSource);
          },
          { propagation: Propagation.NESTED },
        );

        outerTransactionIdAfter = await getCurrentTransactionId(dataSource);
      });

      expect(outerTransactionId).toBeTruthy();
      expect(innerTransactionId).toBeTruthy();
      expect(innerTransactionId).not.toBe(outerTransactionId);
      expect(outerTransactionIdAfter).toBe(outerTransactionId);
    });

    it('inner NESTED commit currently survives outer rollback', async () => {
      // CHARACTERIZATION: wrong, will change in #6 (a SAVEPOINT belongs to the parent
      // transaction, so the outer rollback would discard the inner write too)
      try {
        await runInTransaction(async () => {
          await createUser('nested-outer');

          await runInTransaction(
            async () => {
              await createUser('nested-inner');
            },
            { propagation: Propagation.NESTED },
          );

          throw new Error('outer rollback');
        });
      } catch {}

      expect(await findUser('nested-outer')).toBe(null);
      expect(await findUser('nested-inner')).toEqual(new User('nested-inner', 0));
    });

    it('inner NESTED throw (caught in the outer) discards only the inner work', async () => {
      // Same observable outcome as the future SAVEPOINT semantics, but via an independent
      // transaction today — only the mechanism changes in #6.
      await runInTransaction(async () => {
        await createUser('nested-outer-commits');

        try {
          await runInTransaction(
            async () => {
              await createUser('nested-inner-throws');
              throw new Error('inner rollback');
            },
            { propagation: Propagation.NESTED },
          );
        } catch {}
      });

      expect(await findUser('nested-outer-commits')).toEqual(new User('nested-outer-commits', 0));
      expect(await findUser('nested-inner-throws')).toBe(null);
    });
  });

  describe('Propagation.NOT_SUPPORTED', () => {
    // Only the normal-completion path is pinned here. The error path is broken today: the
    // suspended EntityManager is restored without try/finally, so a throw inside the
    // NOT_SUPPORTED body leaves the outer context corrupted — fixed by #4, not pinned.
    it('suspends the transaction (non-transactional body) and restores the outer manager', async () => {
      let outerTransactionId: number | null = null;
      let insideTransactionId: number | null = null;
      let outerTransactionIdAfter: number | null = null;

      try {
        await runInTransaction(async () => {
          outerTransactionId = await getCurrentTransactionId(dataSource);

          await runInTransaction(
            async () => {
              insideTransactionId = await getCurrentTransactionId(dataSource);
              await createUser('not-supported-write');
            },
            { propagation: Propagation.NOT_SUPPORTED },
          );

          outerTransactionIdAfter = await getCurrentTransactionId(dataSource);
          throw new Error('outer rollback');
        });
      } catch {}

      // No transactional manager inside the NOT_SUPPORTED body
      expect(outerTransactionId).toBeTruthy();
      expect(insideTransactionId).toBe(null);

      // The suspended outer manager is restored after normal completion of the body
      expect(outerTransactionIdAfter).toBe(outerTransactionId);

      // The write ran non-transactionally, so it survives the outer rollback
      expect(await findUser('not-supported-write')).toEqual(new User('not-supported-write', 0));
    });
  });

  describe('Hooks', () => {
    it('commit hook does NOT fire before the caller continuation, only after a macrotask flush', async () => {
      // CHARACTERIZATION: wrong, will change in #18 (hooks are emitted via setImmediate today;
      // #18 awaits them before the wrapper resolves)
      let commitHookFired = false;

      await runInTransaction(async () => {
        runOnTransactionCommit(() => {
          commitHookFired = true;
        });
      });

      // The caller continuation runs first — the hook has NOT fired yet
      expect(commitHookFired).toBe(false);

      await flushMacrotasks();
      expect(commitHookFired).toBe(true);
    });

    it('registering a commit hook inside a JOINED transaction works and fires once on outer commit', async () => {
      // Reference #5: the issue text expects "No hook manager found in context" on join paths,
      // but empirically (both drivers) the join path sees the OUTER transaction's hook emitter
      // through the context store copy, so registration succeeds and the hook fires exactly
      // once, when the real (outer) transaction commits. #5 formalizes this outer-registry
      // reuse, so this pin is expected to stay green.
      let commitHookFiredCount = 0;
      let firedInsideOuterTransaction = 0;

      await runInTransaction(async () => {
        await runInTransaction(
          async () => {
            runOnTransactionCommit(() => {
              commitHookFiredCount += 1;
            });
          },
          { propagation: Propagation.REQUIRED },
        );

        // Joining does not create a hook scope of its own: nothing fires at inner completion
        firedInsideOuterTransaction = commitHookFiredCount;
      });

      expect(firedInsideOuterTransaction).toBe(0);

      await flushMacrotasks();
      expect(commitHookFiredCount).toBe(1);
    });

    it('rollback hook receives the thrown error, but only after a macrotask flush', async () => {
      // CHARACTERIZATION: timing is wrong, will change in #18 (same setImmediate machinery)
      const thrown = new Error('rollback-hook-boom');
      let receivedError: Error | null = null;

      try {
        await runInTransaction(async () => {
          runOnTransactionRollback((error) => {
            receivedError = error;
          });

          await createUser('rollback-hook-user');
          throw thrown;
        });
      } catch {}

      // The caller continuation runs first — the rollback hook has NOT fired yet
      expect(receivedError).toBe(null);

      await flushMacrotasks();
      expect(receivedError).toBe(thrown);

      // And the transaction was indeed rolled back
      expect(await findUser('rollback-hook-user')).toBe(null);
    });
  });
});
