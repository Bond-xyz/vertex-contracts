import fs from 'fs';
import path from 'path';
import { artifacts } from 'hardhat';
import { PERPDEX_NETWORK } from './deployment-config';
import {
  createRedTestnetApprovalDraft,
  DeterministicCiEvidence,
  IndependentAgentReviewEvidence,
  TRACKED_RED_GALILEO_APPROVAL,
} from './red-testnet-approval';

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const ciEvidenceFile = path.resolve(required(process.env.PERPDEX_CI_EVIDENCE_FILE, 'PERPDEX_CI_EVIDENCE_FILE'));
  const agentReviewFile = path.resolve(
    required(process.env.PERPDEX_AGENT_REVIEW_EVIDENCE_FILE, 'PERPDEX_AGENT_REVIEW_EVIDENCE_FILE')
  );
  const output = path.resolve(repoRoot, TRACKED_RED_GALILEO_APPROVAL);
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite tracked Red approval: ${output}`);
  const deterministicCi = JSON.parse(fs.readFileSync(ciEvidenceFile, 'utf8')) as DeterministicCiEvidence;
  const independentAgentReviews = JSON.parse(
    fs.readFileSync(agentReviewFile, 'utf8')
  ) as IndependentAgentReviewEvidence[];
  const approval = await createRedTestnetApprovalDraft({
    artifacts,
    productsFile: path.resolve(process.env.PERPDEX_PRODUCTS_FILE || PERPDEX_NETWORK.files.products),
    productReviewFile: path.resolve(process.env.PERPDEX_PRODUCT_REVIEW_FILE || PERPDEX_NETWORK.files.productReview),
    verifierFile: path.resolve(
      process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || PERPDEX_NETWORK.files.verifierPublicKeys
    ),
    deploymentIntentFile: path.resolve(
      process.env.PERPDEX_DEPLOYMENT_INTENT_FILE || PERPDEX_NETWORK.files.deploymentIntent
    ),
    deterministicCi,
    independentAgentReviews,
    repoRoot,
  });
  fs.writeFileSync(output, `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  console.log(`created pending tracked Red approval at ${output}`);
  console.log('Red must review the exact hashes, set decision/approvedAt, and commit only this file.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
