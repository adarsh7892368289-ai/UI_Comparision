import { IDBRepository } from './idb-repository.js';

const storage = new IDBRepository();
storage.applyPendingOperations();

export default storage;