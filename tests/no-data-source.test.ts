import { initializeTransactionalContext, runInTransaction, StorageDriver } from '../src';

const storageDriver =
  process.env.TEST_STORAGE_DRIVER && process.env.TEST_STORAGE_DRIVER in StorageDriver
    ? StorageDriver[process.env.TEST_STORAGE_DRIVER as keyof typeof StorageDriver]
    : undefined;

describe('wrapInTransaction without registered data sources', () => {
  beforeAll(() => {
    initializeTransactionalContext({ storageDriver });
  });

  it('fails with an error naming the real addTransactionalDataSource() API', () => {
    // The wrapper performs init checks synchronously, before entering the async body
    expect(() => runInTransaction(async () => true)).toThrow(
      'please call addTransactionalDataSource() before application start',
    );
  });
});
