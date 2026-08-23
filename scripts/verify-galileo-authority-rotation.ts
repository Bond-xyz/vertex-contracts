import { providers } from 'ethers';
import { loadTrackedAuthorityRotationEvidence, verifyAuthorityRotationEvidence } from './galileo-authority-rotation';

async function main(): Promise<void> {
  const rpcUrl = process.env.PERPDEX_GALILEO_RPC_URL || process.env.GALILEO_RPC_URL;
  if (!rpcUrl) throw new Error('PERPDEX_GALILEO_RPC_URL is required for read-only authority verification');
  const provider = new providers.StaticJsonRpcProvider(rpcUrl, {
    chainId: 16602,
    name: 'galileo',
  });
  const result = await verifyAuthorityRotationEvidence(provider, loadTrackedAuthorityRotationEvidence());
  process.stdout.write(
    `${JSON.stringify({
      verified: true,
      chainId: 16602,
      authority: result.authority,
      transactionCount: result.transactionCount,
      headBlock: result.headBlock,
    })}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`authority rotation verification failed: ${message}\n`);
  process.exitCode = 1;
});
