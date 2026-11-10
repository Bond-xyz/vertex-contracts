import fs from 'fs';
import path from 'path';
import { PERPDEX_NETWORK, resolveSequencer } from './deployment-config';
import { createGalileoDeploymentIntent } from './release-attestation';
import { collectGalileoStaticReleasePolicy } from './stork-deployment-snapshot';

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredNumber(value: string | undefined, label: string): number {
  const parsed = Number(required(value, label));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return parsed;
}

export function createTrackedGalileoDeploymentIntent(): void {
  // Intent preparation binds reviewed static policy/provenance only. A live
  // 30-second snapshot is intentionally deferred to the actual deploy preflight.
  const staticPolicy = collectGalileoStaticReleasePolicy();
  const output = path.resolve(process.env.PERPDEX_DEPLOYMENT_INTENT_FILE || PERPDEX_NETWORK.files.deploymentIntent);
  const deployer = required(process.env.PERPDEX_DEPLOYER_ADDRESS, 'PERPDEX_DEPLOYER_ADDRESS');
  const intent = createGalileoDeploymentIntent({
    deploymentNonce: required(process.env.PERPDEX_DEPLOYMENT_NONCE, 'PERPDEX_DEPLOYMENT_NONCE'),
    expiresAt: requiredNumber(process.env.PERPDEX_RELEASE_EXPIRES_AT, 'PERPDEX_RELEASE_EXPIRES_AT'),
    deployer,
    sequencer: resolveSequencer(required(process.env.PERPDEX_SEQUENCER_ADDRESS, 'PERPDEX_SEQUENCER_ADDRESS'), deployer),
    firstTransactionNonce: requiredNumber(
      process.env.PERPDEX_FIRST_TRANSACTION_NONCE,
      'PERPDEX_FIRST_TRANSACTION_NONCE'
    ),
    backendBetaCommit: staticPolicy.policy.backend.releaseCommit,
    storkPolicySha256: staticPolicy.policySha256,
    collateralProvenanceSha256: staticPolicy.collateralProvenanceSha256,
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`created single-use ${PERPDEX_NETWORK.name} deployment intent at ${output}`);
  console.log(`deployment ID: ${intent.deploymentId}`);
  console.log(`expected first contract: ${intent.expectedFirstContract}`);
}

if (require.main === module) createTrackedGalileoDeploymentIntent();
