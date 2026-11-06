// Public surface of the lifecycle module. Other modules import only from here.
export {
  createLifecycleWorker,
  type LifecycleFaults,
  type LifecycleOptions,
  type LifecycleWorker,
  type PassResult,
} from './worker.ts';
