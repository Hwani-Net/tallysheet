/**
 * Pure multi-channel fee, net profit, and reverse-pricing math engine.
 * Shared by web calculators, automated verification tests, and marketing scripts.
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Computes unit profit and itemized platform fees for a single order.
 */
export function calculateOrderProfit(input, channelSpec, options = {}) {
  const salePrice = Math.max(0, num(input?.salePrice));
  const discountRate = Math.min(0.99, Math.max(0, num(input?.discountRate)));
  const shippingCharged = Math.max(0, num(input?.shippingCharged));
  const cogs = Math.max(0, num(input?.cogs));
  const shippingCost = Math.max(0, num(input?.shippingCost));
  const adSpend = Math.max(0, num(input?.adSpend));
  const offsiteAdsMode = options?.offsiteAdsMode ?? 'none';

  const grossRevenue = salePrice * (1 - discountRate) + shippingCharged;
  const listingFee = num(channelSpec?.listingFee);
  const transactionFee = grossRevenue * num(channelSpec?.transactionRate);
  const paymentFixed = num(channelSpec?.paymentFixed);
  const paymentFee = grossRevenue * num(channelSpec?.paymentRate) + paymentFixed;
  const thirdPartyFee = grossRevenue * num(channelSpec?.thirdPartyPenaltyRate);
  const fxBufferFee = grossRevenue * num(channelSpec?.fxBufferRate);

  const offsiteRate =
    offsiteAdsMode === '15'
      ? num(channelSpec?.offsiteAdsOptionalRate)
      : offsiteAdsMode === '12'
        ? num(channelSpec?.offsiteAdsMandatoryRate)
        : 0;

  const cap = num(channelSpec?.offsiteAdsCap) > 0 ? num(channelSpec.offsiteAdsCap) : Infinity;
  const offsiteAdsFee = offsiteRate > 0 ? Math.min(grossRevenue * offsiteRate, cap) : 0;

  const totalPlatformFees =
    listingFee + transactionFee + paymentFee + thirdPartyFee + fxBufferFee + offsiteAdsFee;
  const hardCosts = cogs + shippingCost + adSpend;
  const netProfit = grossRevenue - totalPlatformFees - hardCosts;
  const netMargin = grossRevenue > 0 ? netProfit / grossRevenue : 0;
  const effectiveFeeRate = grossRevenue > 0 ? totalPlatformFees / grossRevenue : 0;

  return {
    grossRevenue,
    listingFee,
    transactionFee,
    paymentFee,
    thirdPartyFee,
    fxBufferFee,
    offsiteAdsFee,
    totalPlatformFees,
    hardCosts,
    netProfit,
    netMargin,
    effectiveFeeRate,
  };
}

/**
 * Solves closed-form required sale price to hit a target net margin rate after all platform fees.
 */
export function calculateReversePrice(input, channelSpec, options = {}) {
  const cogs = Math.max(0, num(input?.cogs));
  const shippingCost = Math.max(0, num(input?.shippingCost));
  const shippingCharged = Math.max(0, num(input?.shippingCharged));
  const adSpend = Math.max(0, num(input?.adSpend));
  const discountRate = Math.min(0.95, Math.max(0, num(input?.discountRate)));
  const targetMarginRate = Math.max(0, num(input?.targetMarginRate));
  const offsiteAdsMode = options?.offsiteAdsMode ?? 'none';

  const listingFee = num(channelSpec?.listingFee);
  const paymentFixed = num(channelSpec?.paymentFixed);
  const variableRate =
    num(channelSpec?.transactionRate) +
    num(channelSpec?.paymentRate) +
    num(channelSpec?.thirdPartyPenaltyRate) +
    num(channelSpec?.fxBufferRate);

  const offsiteRate =
    offsiteAdsMode === '15'
      ? num(channelSpec?.offsiteAdsOptionalRate)
      : offsiteAdsMode === '12'
        ? num(channelSpec?.offsiteAdsMandatoryRate)
        : 0;
  const cap = num(channelSpec?.offsiteAdsCap) > 0 ? num(channelSpec.offsiteAdsCap) : Infinity;

  const fixedCosts = cogs + shippingCost + adSpend + listingFee + paymentFixed;
  const uncappedDenominator = 1 - (variableRate + offsiteRate + targetMarginRate);

  let requiredGross = null;
  let offsiteCapApplied = false;

  if (uncappedDenominator > 0.01) {
    const candidateGross = fixedCosts / uncappedDenominator;
    if (offsiteRate > 0 && candidateGross * offsiteRate > cap) {
      offsiteCapApplied = true;
    } else {
      requiredGross = candidateGross;
    }
  } else if (offsiteRate > 0 && Number.isFinite(cap)) {
    offsiteCapApplied = true;
  }

  if (offsiteCapApplied) {
    const cappedDenominator = 1 - (variableRate + targetMarginRate);
    if (cappedDenominator <= 0.01) {
      return {
        feasible: false,
        requiredSalePrice: null,
        requiredGross: null,
        offsiteCapApplied: true,
        reason: 'Combined fee rate and target margin exceed 99%.',
      };
    }
    const candidateCapped = (fixedCosts + cap) / cappedDenominator;
    if (candidateCapped * offsiteRate >= cap) {
      requiredGross = candidateCapped;
    } else {
      return {
        feasible: false,
        requiredSalePrice: null,
        requiredGross: null,
        offsiteCapApplied: false,
        reason: 'Combined fee rate and target margin exceed 99%.',
      };
    }
  }

  if (requiredGross === null) {
    return {
      feasible: false,
      requiredSalePrice: null,
      requiredGross: null,
      offsiteCapApplied: false,
      reason: 'Combined fee rate and target margin exceed 99%.',
    };
  }

  const netSaleRequired = Math.max(0, requiredGross - shippingCharged);
  const requiredSalePrice = discountRate > 0 ? netSaleRequired / (1 - discountRate) : netSaleRequired;

  return {
    feasible: true,
    requiredSalePrice,
    requiredGross,
    offsiteCapApplied,
    reason: null,
  };
}

/**
 * Compares all channels for a given unit profile and monthly order volume.
 */
export function compareChannels(input, feesData, monthlyOrders = 50, options = {}) {
  const orders = Math.max(0, num(monthlyOrders, 50));
  const channels = Object.values(feesData?.channels ?? {});

  const rows = channels.map((spec) => {
    const unit = calculateOrderProfit(input, spec, options);
    const monthlyPlanFee = num(spec.monthlyPlanFee);
    const planFeePerOrder = orders > 0 ? monthlyPlanFee / orders : 0;
    const monthlyNetProfit = unit.netProfit * orders - monthlyPlanFee;
    const netAfterPlanPerOrder = orders > 0 ? monthlyNetProfit / orders : unit.netProfit;

    return {
      ...spec,
      ...unit,
      monthlyPlanFee,
      planFeePerOrder,
      netAfterPlanPerOrder,
      monthlyNetProfit,
    };
  });

  const sorted = [...rows].sort((a, b) => b.monthlyNetProfit - a.monthlyNetProfit);
  const bestChannel = sorted[0] ?? null;

  const shopifyUs = rows.find((r) => r.id === 'shopify_basic_us');
  const etsyUs = rows.find((r) => r.id === 'etsy_us');
  let breakEvenShopifyVsEtsyOrders = null;

  if (shopifyUs && etsyUs) {
    const diffPerOrder = shopifyUs.netProfit - etsyUs.netProfit;
    if (diffPerOrder > 0.0001) {
      breakEvenShopifyVsEtsyOrders = Math.ceil(shopifyUs.monthlyPlanFee / diffPerOrder);
    }
  }

  return {
    monthlyOrders: orders,
    channels: rows,
    bestChannelId: bestChannel?.id ?? null,
    breakEvenShopifyVsEtsyOrders,
  };
}
