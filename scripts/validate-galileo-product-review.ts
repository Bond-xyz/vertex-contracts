import fs from 'fs';
import path from 'path';
import { utils } from 'ethers';
import {
  GALILEO_CHAIN_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  loadProducts,
} from './deployment-config';
import {
  BACKEND_PROTOCOL_BASELINE_COMMIT,
  loadTrackedCollateralProvenance,
  loadTrackedStorkDeploymentPolicy,
  TRACKED_COLLATERAL_PROVENANCE,
  TRACKED_STORK_DEPLOYMENT_POLICY,
} from './stork-deployment-snapshot';

type ReviewMarket = {
  productId: number;
  symbol: string;
  contractSizeIncrement: string;
  contractMinimumSize: string;
  rustSizeIncrement: string;
  rustMinimumSize: string;
  rustMinimumPrice: string;
  rustMaximumPrice: string;
  rustTickSize: string;
  sizeStatus: string;
  initialPriceSource: string;
  storkFeedId: string;
};

type ProductApprovalReview = {
  schemaVersion: number;
  reviewId: string;
  chainId: number;
  collateral: {
    address: string;
    productId: number;
    symbol: string;
    decimals: number;
    provenanceFile: string;
    provenanceSha256: string;
    selectionMode: string;
  };
  contractSource: {
    repository: string;
    releaseCommit: string;
    releaseTree: string;
    productsFile: string;
  };
  rustSource: {
    repository: string;
    releaseCommit: string;
    releaseCommitRole: string;
    symbolsFile: string;
    baseDecimals: number;
  };
  initialPricePolicy: {
    source: string;
    policyFile: string;
    policySha256: string;
    staticPriceAllowed: boolean;
    snapshotTracked: boolean;
    graphPreparationRequiresSnapshot: boolean;
    snapshotRequiredBeforeFirstPriceBearingTransaction: boolean;
  };
  riskModel: {
    initialMarginPercent: string;
    maintenanceMarginPercent: string;
    maximumLeverage: string;
    weightStorageDecimals: number;
    contractWeightDecimals: number;
  };
  markets: ReviewMarket[];
  blockers: string[];
  approval: {
    approved: boolean;
    approver: string;
    decision: string;
    approvedAt: string | null;
    recordedScope: string;
  };
};

export type ProductReviewResult = {
  // `ready` is deliberately only the static market-size and 20x-vector verdict.
  // Deployment additionally requires the dynamic signed Stork preflight.
  ready: boolean;
  staticVectorsReady: boolean;
  scope: 'static_market_size_and_20x_only';
  blockers: string[];
  backendProtocolBaselineCommit: string;
  storkPolicySha256: string;
  collateralProvenanceSha256: string;
  marketVectors: Array<{
    productId: number;
    symbol: string;
    contractSizeIncrementX18: string;
    contractMinimumSizeX18: string;
    rustSizeIncrementRaw: string;
    rustMinimumSizeRaw: string;
    rustSizeIncrementX18: string;
    rustMinimumSizeX18: string;
    rustMinimumPriceX18: string;
    rustMaximumPriceX18: string;
    rustTickSizeX18: string;
    sizeMatch: boolean;
    initialPriceSource: 'verified_stork_deployment_snapshot';
    storkFeedId: string;
    match: boolean;
  }>;
};

export const TRACKED_GALILEO_PRODUCT_REVIEW = 'config/galileo.product-approval-review.json';
export const TRACKED_GALILEO_PRODUCTS = 'config/galileo.products.json';
export const GALILEO_CONTRACT_PACKET_BASE_COMMIT = '8ac5c9f3dfd4c5afc33e940400ead69c719fe043';
export const GALILEO_CONTRACT_PACKET_BASE_TREE = 'fa7c4782c141c55ab8ecfa51a297bec1c6a4c43f';

function decimalToUnits(value: string, decimals: number, label: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${label} must be an unsigned decimal`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`${label} exceeds ${decimals} decimals`);
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
}

function requireGitObject(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be a 40-character Git object`);
}

export function validateProductApprovalReview(
  repoRoot = path.resolve(__dirname, '..'),
  options: { requireApproved?: boolean } = {}
): ProductReviewResult {
  const review = JSON.parse(
    fs.readFileSync(path.join(repoRoot, TRACKED_GALILEO_PRODUCT_REVIEW), 'utf8')
  ) as ProductApprovalReview;
  const products = loadProducts(path.join(repoRoot, TRACKED_GALILEO_PRODUCTS), { requireApproved: false });
  const stork = loadTrackedStorkDeploymentPolicy(repoRoot);
  const collateral = loadTrackedCollateralProvenance(repoRoot);
  if (
    review.schemaVersion !== 3 ||
    review.reviewId !== 'bond-perpdex-galileo-product-vectors' ||
    review.chainId !== GALILEO_CHAIN_ID
  ) {
    throw new Error('Galileo product approval review identity mismatch');
  }
  if (
    utils.getAddress(review.collateral.address) !== GALILEO_USDCE_ADDRESS ||
    review.collateral.productId !== 0 ||
    review.collateral.symbol !== GALILEO_USDCE_SYMBOL ||
    review.collateral.decimals !== GALILEO_USDCE_DECIMALS ||
    review.collateral.provenanceFile !== TRACKED_COLLATERAL_PROVENANCE ||
    review.collateral.provenanceSha256 !== collateral.provenanceSha256 ||
    review.collateral.selectionMode !== 'static_pinned'
  ) {
    throw new Error('product approval review does not pin exact static Galileo USDC.e provenance');
  }
  requireGitObject(review.contractSource.releaseCommit, 'contract source commit');
  requireGitObject(review.contractSource.releaseTree, 'contract source tree');
  requireGitObject(review.rustSource.releaseCommit, 'Rust source commit');
  if (
    review.contractSource.repository !== 'Bond-xyz/vertex-contracts' ||
    review.contractSource.releaseCommit !== GALILEO_CONTRACT_PACKET_BASE_COMMIT ||
    review.contractSource.releaseTree !== GALILEO_CONTRACT_PACKET_BASE_TREE ||
    review.contractSource.productsFile !== TRACKED_GALILEO_PRODUCTS ||
    review.rustSource.repository !== 'Bond-xyz/perpdex-rust-backend' ||
    review.rustSource.releaseCommit !== BACKEND_PROTOCOL_BASELINE_COMMIT ||
    review.rustSource.releaseCommitRole !== 'reviewed_protocol_baseline_only' ||
    review.rustSource.symbolsFile !== 'core/types/src/symbol.rs'
  ) {
    throw new Error('product review does not pin the tracked contract and reviewed backend protocol baseline');
  }
  if (
    review.initialPricePolicy.source !== 'verified_stork_deployment_snapshot' ||
    review.initialPricePolicy.policyFile !== TRACKED_STORK_DEPLOYMENT_POLICY ||
    review.initialPricePolicy.policySha256 !== stork.policySha256 ||
    review.initialPricePolicy.staticPriceAllowed !== false ||
    review.initialPricePolicy.snapshotTracked !== false ||
    review.initialPricePolicy.graphPreparationRequiresSnapshot !== false ||
    review.initialPricePolicy.snapshotRequiredBeforeFirstPriceBearingTransaction !== true
  ) {
    throw new Error(
      'product review must allow non-price graph preparation and require exact verified Stork prices before the first price-bearing transaction'
    );
  }
  if (review.rustSource.baseDecimals !== 8) {
    throw new Error('Rust product quantities must use the tracked 8-decimal base-unit representation');
  }
  if (
    review.riskModel.initialMarginPercent !== '5' ||
    review.riskModel.maintenanceMarginPercent !== '2.5' ||
    review.riskModel.maximumLeverage !== '20' ||
    review.riskModel.weightStorageDecimals !== 9 ||
    review.riskModel.contractWeightDecimals !== 18
  ) {
    throw new Error('product approval review risk model is not the tracked 20x Gate-1 model');
  }

  const expectedRisk = {
    longWeightInitial: 950_000_000,
    shortWeightInitial: 1_050_000_000,
    longWeightMaintenance: 975_000_000,
    shortWeightMaintenance: 1_025_000_000,
  };
  const expectedProductIds = products.products.map((product) => product.productId);
  const reviewedProductIds = review.markets.map((market) => market.productId);
  if (
    review.markets.length !== expectedProductIds.length ||
    new Set(reviewedProductIds).size !== reviewedProductIds.length ||
    JSON.stringify(reviewedProductIds) !== JSON.stringify(expectedProductIds)
  ) {
    throw new Error('product review markets must be exactly the tracked Galileo products in order');
  }
  const reviewByProduct = new Map(review.markets.map((market) => [market.productId, market]));
  const storkByProduct = new Map(stork.policy.feeds.map((feed) => [feed.productId, feed]));
  const blockers: string[] = [];
  const marketVectors = products.products.map((product) => {
    const reviewed = reviewByProduct.get(product.productId);
    const feed = storkByProduct.get(product.productId);
    if (!reviewed || reviewed.symbol !== product.symbol || !feed) {
      throw new Error(`missing Rust/contract/Stork review vector for product ${product.productId}`);
    }
    for (const [field, expected] of Object.entries(expectedRisk)) {
      if (product.risk[field as keyof typeof expectedRisk] !== expected) {
        blockers.push(`${product.symbol} ${field} does not match the tracked 20x risk vector`);
      }
    }
    const contractSizeIncrementX18 = decimalToUnits(
      reviewed.contractSizeIncrement,
      18,
      `${product.symbol} contract size increment`
    );
    const contractMinimumSizeX18 = decimalToUnits(
      reviewed.contractMinimumSize,
      18,
      `${product.symbol} contract minimum size`
    );
    if (contractSizeIncrementX18.toString() !== product.sizeIncrementX18) {
      throw new Error(`${product.symbol} review/config size increment drift`);
    }
    if (contractMinimumSizeX18.toString() !== product.minSizeX18) {
      throw new Error(`${product.symbol} review/config minimum size drift`);
    }
    const rustSizeIncrementRaw = decimalToUnits(
      reviewed.rustSizeIncrement,
      review.rustSource.baseDecimals,
      `${product.symbol} Rust size increment`
    );
    const rustMinimumSizeRaw = decimalToUnits(
      reviewed.rustMinimumSize,
      review.rustSource.baseDecimals,
      `${product.symbol} Rust minimum size`
    );
    const rustToContractScale = 10n ** BigInt(18 - review.rustSource.baseDecimals);
    const rustSizeIncrementX18 = rustSizeIncrementRaw * rustToContractScale;
    const rustMinimumSizeX18 = rustMinimumSizeRaw * rustToContractScale;
    const sizeMatch =
      rustSizeIncrementX18 === contractSizeIncrementX18 && rustMinimumSizeX18 === contractMinimumSizeX18;
    if (!sizeMatch) {
      blockers.push(
        `${product.symbol} contract step/minimum are ${reviewed.contractSizeIncrement}/${reviewed.contractMinimumSize} while the reviewed protocol baseline step/minimum are ${reviewed.rustSizeIncrement}/${reviewed.rustMinimumSize}`
      );
    }
    if (reviewed.sizeStatus !== (sizeMatch ? 'match' : 'blocked_mismatch')) {
      throw new Error(`${product.symbol} stored size review status does not match computed vector result`);
    }
    const rustMinimumPriceX18 = decimalToUnits(reviewed.rustMinimumPrice, 18, `${product.symbol} Rust minimum price`);
    const rustMaximumPriceX18 = decimalToUnits(reviewed.rustMaximumPrice, 18, `${product.symbol} Rust maximum price`);
    const rustTickSizeX18 = decimalToUnits(reviewed.rustTickSize, 18, `${product.symbol} Rust price tick`);
    if (rustMinimumPriceX18 <= 0n || rustMaximumPriceX18 < rustMinimumPriceX18 || rustTickSizeX18 <= 0n) {
      throw new Error(`${product.symbol} accepted-beta price bounds are invalid`);
    }
    if (
      reviewed.initialPriceSource !== 'verified_stork_deployment_snapshot' ||
      reviewed.storkFeedId !== feed.feedId ||
      reviewed.symbol !== feed.symbol
    ) {
      throw new Error(`${product.symbol} initial price must map to its exact signed Stork feed`);
    }
    return {
      productId: product.productId,
      symbol: product.symbol,
      contractSizeIncrementX18: contractSizeIncrementX18.toString(),
      contractMinimumSizeX18: contractMinimumSizeX18.toString(),
      rustSizeIncrementRaw: rustSizeIncrementRaw.toString(),
      rustMinimumSizeRaw: rustMinimumSizeRaw.toString(),
      rustSizeIncrementX18: rustSizeIncrementX18.toString(),
      rustMinimumSizeX18: rustMinimumSizeX18.toString(),
      rustMinimumPriceX18: rustMinimumPriceX18.toString(),
      rustMaximumPriceX18: rustMaximumPriceX18.toString(),
      rustTickSizeX18: rustTickSizeX18.toString(),
      sizeMatch,
      initialPriceSource: 'verified_stork_deployment_snapshot' as const,
      storkFeedId: feed.feedId,
      match: sizeMatch,
    };
  });

  if (JSON.stringify(review.blockers) !== JSON.stringify(blockers)) {
    throw new Error('stored Galileo product-review blockers do not match the computed static vectors');
  }
  if (review.approval.approver !== 'Red') {
    throw new Error('Galileo product-vector approval is restricted to Red');
  }
  if (
    review.approval.approved !== true ||
    review.approval.decision !== 'approve_galileo_vectors_with_verified_stork_deploy_time_prices' ||
    !review.approval.approvedAt ||
    !Number.isFinite(Date.parse(review.approval.approvedAt)) ||
    !review.approval.recordedScope.includes('no fixed deploy-time prices')
  ) {
    throw new Error('static Galileo vectors require Red approval with the Stork deploy-time override');
  }
  const staticVectorsReady = blockers.length === 0 && review.approval.approved && products.approved;
  if (options.requireApproved && !staticVectorsReady) {
    throw new Error(
      `Galileo static market-vector approval is not ready: ${[
        ...blockers,
        ...(!review.approval.approved ? ['tracked Red static-vector approval is false'] : []),
        ...(!products.approved ? ['galileo.products.json static vector approved is false'] : []),
      ].join('; ')}`
    );
  }
  return {
    ready: staticVectorsReady,
    staticVectorsReady,
    scope: 'static_market_size_and_20x_only',
    blockers,
    backendProtocolBaselineCommit: BACKEND_PROTOCOL_BASELINE_COMMIT,
    storkPolicySha256: stork.policySha256,
    collateralProvenanceSha256: collateral.provenanceSha256,
    marketVectors,
  };
}

if (require.main === module) {
  const result = validateProductApprovalReview(path.resolve(__dirname, '..'), {
    requireApproved: process.argv.includes('--require-approved'),
  });
  console.log(JSON.stringify(result, null, 2));
}
