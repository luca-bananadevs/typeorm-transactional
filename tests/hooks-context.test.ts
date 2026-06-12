import { DataSource } from 'typeorm';
import {
  addTransactionalDataSource,
  getTransactionalContext,
  initializeTransactionalContext,
  runInTransaction,
  runOnTransactionCommit,
  StorageDriver,
} from '../src';
import { TYPEORM_DATA_SOURCE_NAME_PREFIX, TYPEORM_HOOK_NAME } from '../src/common/constants';

import { User } from './entities/User.entity';
import { Counter } from './entities/Counter.entity';

import { UserRepository } from './repositories/user.repository';

import { getCurrentTransactionId } from './utils';

/**
 * Failing repro for fork issue #16: commit/rollback hooks run outside the
 * transactional context.
 *
 * `runAndTriggerHooks` (src/hooks/index.ts) emits the `commit` / `rollback` /
 * `end` events via `setImmediate`, i.e. on a later macrotask — AFTER
 * `context.run()` has unwound and AFTER the decorated call's promise has
 * resolved. As a result:
 *
 *   - a caller awaiting the transactional call cannot rely on commit hooks
 *     having run once the call resolves (upstream tests paper over this with
 *     `sleep()` calls);
 *   - the hook callback no longer sees the transactional store it was
 *     registered in, so context-dependent APIs misbehave inside hooks.
 *
 * The buggy expectations below are marked `it.failing` unconditionally (the
 * bug affects BOTH storage drivers) and flip to green with the hook redesign
 * tracked in fork issue #18.
 */

const port = Number(process.env.TEST_PG_PORT ?? 5435);

// This file creates and connects to ITS OWN database: jest runs test files in
// parallel workers and the shared "test" database is dropped/synchronized by
// other suites (e.g. simple.test.ts).
const database = 'test_hooks';

const dataSource = new DataSource({
  type: 'postgres',
  host: 'localhost',
  port,
  username: 'postgres',
  password: 'postgres',
  database,
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
  // Short-lived bootstrap connection to the always-present "test" database,
  // used only to create this file's dedicated database if missing.
  const bootstrap = new DataSource({
    type: 'postgres',
    host: 'localhost',
    port,
    username: 'postgres',
    password: 'postgres',
    database: 'test',
  });

  await bootstrap.initialize();
  try {
    const existing = await bootstrap.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      database,
    ]);
    if (existing.length === 0) {
      await bootstrap.query(`CREATE DATABASE ${database}`);
    }
  } finally {
    await bootstrap.destroy();
  }

  await dataSource.initialize();
});

afterAll(async () => {
  await dataSource.destroy();
});

afterEach(async () => {
  await dataSource.createEntityManager().clear(User);
  await dataSource.createEntityManager().clear(Counter);
});

describe('Transaction hooks timing and context (issue #16)', () => {
  // Consequence 1 — ordering: a `runOnTransactionCommit` callback does NOT run
  // before the caller's continuation. Will be fixed by the hook redesign (#18).
  it.failing('runs "runOnTransactionCommit" callbacks before the caller continuation', async () => {
    const userRepository = new UserRepository(dataSource);
    const order: string[] = [];

    await runInTransaction(async () => {
      order.push('body');
      await userRepository.createUser('John Doe');

      runOnTransactionCommit(() => {
        order.push('hook');
      });
    });

    // Caller continuation: the code awaiting the transactional call.
    order.push('after');

    // No sleep() and no macrotask flush here, on purpose: a post-commit hook
    // is only useful if the caller can rely on it having run by the time the
    // transactional call resolves. Today src/hooks/index.ts parks the emit
    // behind setImmediate, so at this point `order` is ['body', 'after'] —
    // the hook runs later (or never, as far as this caller can observe).
    expect(order).toEqual(['body', 'hook', 'after']);
  });

  // Consequence 2 — context: the commit hook runs after `context.run()` has
  // unwound, so it no longer executes inside the transactional context it was
  // registered in. Will be fixed by the hook redesign (#18).
  it.failing(
    'runs "runOnTransactionCommit" callbacks inside an active transactional context, before the caller continuation',
    async () => {
      const userRepository = new UserRepository(dataSource);

      let continuationReached = false;

      // Evidence is collected into variables inside the hook and asserted at
      // the end, so the test stays deterministic (no sleeps, no races).
      let hookRan = false;
      let hookRanBeforeContinuation = false;
      let contextActiveInHook: boolean | undefined;
      let hookEmitterPresentInHook: boolean | undefined;
      let entityManagerPresentInHook: boolean | undefined;
      let hookQueries: Promise<void> | undefined;
      let hookQueriesResolved = false;
      let usersSeenByHook: number | undefined;
      let transactionIdInHook: number | null | undefined;

      await runInTransaction(async () => {
        await userRepository.createUser('John Doe');

        runOnTransactionCommit(() => {
          hookRan = true;
          hookRanBeforeContinuation = !continuationReached;

          // Store state observed inside the hook. With the setImmediate
          // dispatch of src/hooks/index.ts the transactional store has already
          // been torn down: the ALS driver reports a stale-but-"active" empty
          // store (the hook emitter is gone), while cls-hooked re-binds the
          // old context but its transactional entity manager has been cleared.
          const context = getTransactionalContext();
          contextActiveInHook = context?.active;
          hookEmitterPresentInHook = !!context?.get(TYPEORM_HOOK_NAME);
          entityManagerPresentInHook = !!context?.get(TYPEORM_DATA_SOURCE_NAME_PREFIX + 'default');

          // Repository access from inside the hook: capture whether it
          // resolves before the test ends and what it observes. Today it only
          // works by silently falling back to the non-transactional manager.
          hookQueries = (async () => {
            usersSeenByHook = await userRepository.count();
            transactionIdInHook = await getCurrentTransactionId(userRepository);
            hookQueriesResolved = true;
          })();
        });
      });

      continuationReached = true;

      // EVIDENCE GATHERING ONLY — current (buggy) behavior dispatches the hook
      // via setImmediate, so without draining one macrotask the hook would
      // never run inside this test and we could not capture what it observes.
      // This flush CANNOT make the failing expectations below pass:
      // `hookRanBeforeContinuation` was already fixed (to false) at the moment
      // the hook executed, after `continuationReached` had been set above.
      await new Promise(setImmediate);
      if (hookQueries) {
        await hookQueries;
      }

      // Sanity: the hook did run and its repository query did resolve before
      // the test ended (just late and outside any transaction — today
      // `transactionIdInHook` is null and `usersSeenByHook` reads the already
      // committed row through the fallback manager).
      expect(hookRan).toBe(true);
      expect(hookQueriesResolved).toBe(true);

      // (a) The hook must execute inside an active transactional context that
      // still holds the state it was registered in.
      expect(contextActiveInHook).toBe(true);
      expect(hookEmitterPresentInHook).toBe(true);

      // (b) The hook must execute before the caller continuation. This is the
      // deterministic red expectation today: setImmediate always loses to the
      // microtask that resumes the awaiting caller.
      expect(hookRanBeforeContinuation).toBe(true);
    },
  );

  // Consequence 3 — GREEN characterization test of CURRENT behavior: the hook
  // does fire eventually, but only on a later macrotask. This proves the hooks
  // themselves work and only their timing/context is wrong. To be updated (the
  // explicit flush removed) by the hook redesign in #18.
  it('currently fires the commit hook only on a later macrotask (characterization for #18)', async () => {
    const userRepository = new UserRepository(dataSource);
    const order: string[] = [];

    await runInTransaction(async () => {
      order.push('body');
      await userRepository.createUser('Jane Doe');

      runOnTransactionCommit(() => {
        order.push('hook');
      });
    });

    order.push('after');

    // Deterministic today: the emit of src/hooks/index.ts is queued behind
    // setImmediate, and the microtasks resuming this caller all run before the
    // immediate queue is drained.
    expect(order).toEqual(['body', 'after']);

    // Deterministic macrotask flush — NOT an arbitrary sleep(): it drains the
    // setImmediate queue where the emit was parked. This is the crutch callers
    // are forced into today (upstream tests used sleep() for the same reason).
    await new Promise(setImmediate);

    expect(order).toEqual(['body', 'after', 'hook']);
  });
});
