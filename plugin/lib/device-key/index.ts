// Public surface of the device-tied key + secret-envelope layer (issue 29).
export {
  sealSecret,
  openSecret,
  isSecretEnvelope,
  SecretEnvelopeError,
  SECRET_ENVELOPE_VERSION,
  SECRET_ENVELOPE_ALG,
  SECRET_KEY_BYTES,
  type SecretEnvelope,
} from "./envelope";
export {
  encryptRecord,
  decryptRecord,
  type SecretFieldPath,
  type DecryptRecordResult,
} from "./record-crypto";
export {
  InMemoryKeyProvider,
  KeychainKeyProvider,
  FileKeyProvider,
  createDeviceKeyProvider,
  isSecurityCliAvailable,
  DEVICE_KEY_SERVICE,
  DEVICE_KEY_ACCOUNT,
  type KeyProvider,
  type KeyProviderLog,
  type SecurityRunner,
} from "./key-provider";
