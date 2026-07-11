import fs from 'fs';
import path from 'path';
import { createGalileoDeploymentIntent } from './release-attestation';

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredNumber(value: string | undefined, label: string): number {
  const parsed = Number(required(value, label));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return parsed;
}

const output = path.resolve(
  process.env.PERPDEX_DEPLOYMENT_INTENT_FILE || './config/galileo.deployment-intent.local.json'
);
const intent = createGalileoDeploymentIntent({
  deploymentNonce: required(process.env.PERPDEX_DEPLOYMENT_NONCE, 'PERPDEX_DEPLOYMENT_NONCE'),
  expiresAt: requiredNumber(process.env.PERPDEX_RELEASE_EXPIRES_AT, 'PERPDEX_RELEASE_EXPIRES_AT'),
  deployer: required(process.env.PERPDEX_DEPLOYER_ADDRESS, 'PERPDEX_DEPLOYER_ADDRESS'),
  sequencer: required(process.env.PERPDEX_SEQUENCER_ADDRESS, 'PERPDEX_SEQUENCER_ADDRESS'),
  firstTransactionNonce: requiredNumber(process.env.PERPDEX_FIRST_TRANSACTION_NONCE, 'PERPDEX_FIRST_TRANSACTION_NONCE'),
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(`created single-use Galileo deployment intent at ${output}`);
console.log(`deployment ID: ${intent.deploymentId}`);
console.log(`expected first contract: ${intent.expectedFirstContract}`);
