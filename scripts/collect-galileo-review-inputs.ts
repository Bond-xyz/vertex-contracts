import { execFileSync } from 'child_process';
import path from 'path';
import { artifacts } from 'hardhat';
import {
  collectReleaseBuildEvidence,
  loadReviewedSourceEvidence,
  releaseBuildEvidenceSha256,
  repositoryRoot,
  sha256File,
} from './release-evidence';

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repositoryRoot(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function main() {
  const releaseCommit = git(['rev-parse', 'HEAD']);
  const sourceTree = git(['rev-parse', 'HEAD^{tree}']);
  loadReviewedSourceEvidence(repositoryRoot(), releaseCommit, sourceTree);

  const productsFile = path.resolve(process.env.PERPDEX_PRODUCTS_FILE || './config/galileo.products.json');
  const verifierFile = path.resolve(
    process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || './config/galileo.verifier-public-keys.local.json'
  );
  const build = await collectReleaseBuildEvidence(artifacts);
  console.log(
    JSON.stringify(
      {
        PERPDEX_REVIEWED_RELEASE_COMMIT: releaseCommit,
        PERPDEX_REVIEWED_SOURCE_TREE: sourceTree,
        PERPDEX_REVIEWED_BUILD_EVIDENCE_SHA256: releaseBuildEvidenceSha256(build),
        PERPDEX_REVIEWED_PRODUCT_CONFIG_SHA256: sha256File(productsFile),
        PERPDEX_REVIEWED_VERIFIER_PUBLIC_KEYS_SHA256: sha256File(verifierFile),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
