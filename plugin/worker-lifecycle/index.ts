// Public surface of the worker-lifecycle manager (issue 07).
export {
  WorkerLifecycle,
  WORKER_DEPLOY_DEFAULTS,
  type WorkerLifecycleDeps,
  type WorkerState,
  type WorkerStatus,
  type ConnectionState,
  type ConnectionStatus,
  type TunnelLike,
} from "./worker-lifecycle";
export {
  createWorkerRecordStore,
  workerRecordSchema,
  WORKER_RECORD_KEY,
  WORKER_RECORD_SECRET_FIELDS,
  type WorkerRecord,
  type WorkerRecordStore,
  type WorkerRecordStoreOptions,
  type RecordKv,
} from "./worker-record";
export { bundleWorker, type BundleOptions } from "./worker-bundle";
export {
  deployWorker,
  uploadWorkerScript,
  redactSecrets,
  WORKER_ENV,
  CfDeployError,
  type DeployInput,
  type DeployResult,
  type DeployOptions,
} from "./cf-deploy";
export { mintTunnelSecret, TUNNEL_SECRET_BYTES } from "./tunnel-secret";
export {
  solvePow,
  solveChallenge,
  POW_MAX_ITERATIONS,
  type PowChallenge,
  type PowSolution,
} from "./pow";
