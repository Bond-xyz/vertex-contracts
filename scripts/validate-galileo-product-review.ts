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

type ReviewMarket = {
  productId: number;
  symbol: string;
  contractSizeIncrement: string;
  contractMinimumSize: string;
  rustSizeIncrement: string;
  rustMinimumSize: string;
  status: string;
};

type ProductApprovalReview = {
  schemaVersion: number;
  reviewId: string;
  chainId: number;
  collateral: { address: string; productId: number; symbol: string; decimals: number };
  contractSource: { repository: string; releaseCommit: string; productsFile: string };
  rustSource: { repository: string; releaseCommit: string; symbolsFile: string; baseDecimals: number };
  riskModel: {
    initialMarginPercent: string;
    maintenanceMarginPercent: string;
    maximumLeverage: string;
    weightStorageDecimals: number;
    contractWeightDecimals: number;
  };
  markets: ReviewMarket[];
  blockers: string[];
  approval: { approved: boolean; approver: string; decision: string; approvedAt: string | null };
};

export type ProductReviewResult = {
  ready: boolean;
  blockers: string[];
  marketVectors: Array<{
    productId: number;
    symbol: string;
    contractSizeIncrementX18: string;
    contractMinimumSizeX18: string;
    rustSizeIncrementRaw: string;
    rustMinimumSizeRaw: string;
    rustSizeIncrementX18: string;
    rustMinimumSizeX18: string;
    match: boolean;
  }>;
};

export const TRACKED_GALILEO_PRODUCT_REVIEW = 'config/galileo.product-approval-review.json';
export const TRACKED_GALILEO_PRODUCTS = 'config/galileo.products.json';

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
  if (
    review.schemaVersion !== 1 ||
    review.reviewId !== 'bond-perpdex-galileo-product-vectors' ||
    review.chainId !== GALILEO_CHAIN_ID
  ) {
    throw new Error('Galileo product approval review identity mismatch');
  }
  if (
    utils.getAddress(review.collateral.address) !== GALILEO_USDCE_ADDRESS ||
    review.collateral.productId !== 0 ||
    review.collateral.symbol !== GALILEO_USDCE_SYMBOL ||
    review.collateral.decimals !== GALILEO_USDCE_DECIMALS
  ) {
    throw new Error('product approval review does not pin exact Galileo USDC.e');
  }
  requireGitObject(review.contractSource.releaseCommit, 'contract source commit');
  requireGitObject(review.rustSource.releaseCommit, 'Rust source commit');
  if (
    review.contractSource.repository !== 'Bond-xyz/vertex-contracts' ||
    review.contractSource.productsFile !== TRACKED_GALILEO_PRODUCTS ||
    review.rustSource.repository !== 'Bond-xyz/perpdex-rust-backend' ||
    review.rustSource.symbolsFile !== 'core/types/src/symbol.rs'
  ) {
    throw new Error('product review does not pin the tracked contract and Rust source locations');
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
  const blockers: string[] = [];
  const marketVectors = products.products.map((product) => {
    const reviewed = reviewByProduct.get(product.productId);
    if (!reviewed || reviewed.symbol !== product.symbol) {
      throw new Error(`missing Rust/contract review vector for product ${product.productId}`);
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
    const match = rustSizeIncrementX18 === contractSizeIncrementX18 && rustMinimumSizeX18 === contractMinimumSizeX18;
    if (!match) {
      blockers.push(
        `${product.symbol} contract step/minimum are ${reviewed.contractSizeIncrement}/${reviewed.contractMinimumSize} while Rust step/minimum are ${reviewed.rustSizeIncrement}/${reviewed.rustMinimumSize}; align Rust and frontend metadata to the approved contract values before release approval`
      );
    }
    if (reviewed.status !== (match ? 'match' : 'blocked_mismatch')) {
      throw new Error(`${product.symbol} stored review status does not match computed vector result`);
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
      match,
    };
  });

  if (JSON.stringify(review.blockers) !== JSON.stringify(blockers)) {
    throw new Error('stored Galileo product-review blockers do not match the computed cross-repository vectors');
  }
  if (review.approval.approver !== 'Red') {
    throw new Error('Galileo product-vector approval is restricted to Red');
  }
  if (review.approval.approved) {
    if (
      review.approval.decision !== 'approve_exact_galileo_product_vectors' ||
      !review.approval.approvedAt ||
      !Number.isFinite(Date.parse(review.approval.approvedAt))
    ) {
      throw new Error('approved Galileo product vectors require Red decision and timestamp');
    }
  } else if (review.approval.decision !== 'pending_exact_vector_confirmation' || review.approval.approvedAt !== null) {
    throw new Error('pending Galileo product vectors must remain unapproved and untimestamped');
  }
  const ready = blockers.length === 0 && review.approval.approved && products.approved;
  if (options.requireApproved && !ready) {
    throw new Error(
      `Galileo product approval is not ready: ${[
        ...blockers,
        ...(!review.approval.approved ? ['tracked Red product approval is false'] : []),
        ...(!products.approved ? ['galileo.products.json approved is false'] : []),
      ].join('; ')}`
    );
  }
  return { ready, blockers, marketVectors };
}

if (require.main === module) {
  const result = validateProductApprovalReview(path.resolve(__dirname, '..'), {
    requireApproved: process.argv.includes('--require-approved'),
  });
  console.log(JSON.stringify(result, null, 2));
}
