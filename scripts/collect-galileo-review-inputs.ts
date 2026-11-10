import path from 'path';
import { artifacts } from 'hardhat';
import { PERPDEX_NETWORK } from './deployment-config';
import { collectUnsignedReleaseReviewRequest } from './release-attestation';

async function main() {
  const productsFile = path.resolve(process.env.PERPDEX_PRODUCTS_FILE || PERPDEX_NETWORK.files.products);
  const verifierFile = path.resolve(
    process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || PERPDEX_NETWORK.files.verifierPublicKeys
  );
  const deploymentIntentFile = path.resolve(
    process.env.PERPDEX_DEPLOYMENT_INTENT_FILE || PERPDEX_NETWORK.files.deploymentIntent
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
