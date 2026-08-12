import { config } from './config.js';

const hotRe = new RegExp(config.tiers.hotTitleRegex, 'i');

// Base tier from product attributes. High-demand formats (ETBs, bundles, boxes,
// displays, premium/UPCs) and anything above the price floor poll hot; the rest
// (blisters, single decks, tech stickers, portfolios, poster collections) warm.
export function classify({ title, price }) {
  if (title && hotRe.test(title)) return 'hot';
  if (price != null && price >= config.tiers.hotMinPrice) return 'hot';
  return 'warm';
}
