import fs from 'fs';
import path from 'path';
import {
  assertNoStorkSecretMaterial,
  createStorkDeploymentSnapshotFromRaw,
  DEFAULT_STORK_DEPLOYMENT_SNAPSHOT,
  loadTrackedStorkDeploymentPolicy,
  validateStorkDeploymentSnapshot,
} from './stork-deployment-snapshot';

function main(): void {
  const rawResponseFile = process.env.PERPDEX_STORK_RAW_RESPONSE_FILE;
  const observationFile = process.env.PERPDEX_STORK_OBSERVATION_BLOCK_FILE;
  const outputFile = path.resolve(process.env.PERPDEX_STORK_SNAPSHOT_FILE || DEFAULT_STORK_DEPLOYMENT_SNAPSHOT);
  if (!rawResponseFile || !observationFile) {
    throw new Error(
      'PERPDEX_STORK_RAW_RESPONSE_FILE and PERPDEX_STORK_OBSERVATION_BLOCK_FILE are required; this tool never fetches secrets or network data'
    );
  }
  const rawResponseText = fs.readFileSync(path.resolve(rawResponseFile), 'utf8');
  const observation = JSON.parse(fs.readFileSync(path.resolve(observationFile), 'utf8')) as {
    chainId: number;
    number: number;
    hash: string;
    timestamp: number;
    capturedAtNs: string;
  };
  if (observation.chainId !== 16602) throw new Error('Stork observation block must target Galileo chain 16602');
  const { policy, policySha256 } = loadTrackedStorkDeploymentPolicy();
  const snapshot = createStorkDeploymentSnapshotFromRaw({
    rawResponseText,
    observationBlock: { number: observation.number, hash: observation.hash, timestamp: observation.timestamp },
    capturedAtNs: observation.capturedAtNs,
    policy,
    policySha256,
  });
  // Do not persist a packet that deployment would reject. This verifies the
  // exact signed payload, freshness, observation time, and the reviewed
  // cross-feed coherence decision before creating any release artifact.
  validateStorkDeploymentSnapshot(snapshot, policy, policySha256);
  assertNoStorkSecretMaterial(snapshot);
  fs.writeFileSync(outputFile, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Wrote untracked verified signed Stork snapshot to ${outputFile}`);
  console.log('No API key, authorization header, or private key was read or written.');
}

main();
