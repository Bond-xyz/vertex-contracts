import path from 'path';
import { artifacts } from 'hardhat';
import { collectUnsignedReleaseReviewRequest } from './release-attestation';

async function main() {
  const productsFile = path.resolve(process.env.PERPDEX_PRODUCTS_FILE || './config/galileo.products.json');
  const verifierFile = path.resolve(
    process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || './config/galileo.verifier-public-keys.local.json'
  );
  const deploymentIntentFile = path.resolve(
    process.env.PERPDEX_DEPLOYMENT_INTENT_FILE || './config/galileo.deployment-intent.local.json'
  );
  const request = await collectUnsignedReleaseReviewRequest({
    artifacts,
    productsFile,
    verifierFile,
    deploymentIntentFile,
  });
  console.log(JSON.stringify(request, null, 2));
  console.error('Unsigned review request only. No accepted attestation or reviewer signature was created.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
