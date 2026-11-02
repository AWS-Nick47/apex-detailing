// Prices the server trusts. Keep in sync with the PRICING block in public/index.html
// (the website shows prices; the server decides what a booking actually costs).

export const PRICING = {
  launchSale: true,
  regular: { exterior: [99, 109, 139], interior: [169, 189, 199], full: [249, 279, 309] },
  launch:  { exterior: [69, 79, 109],  interior: [129, 149, 159], full: [179, 199, 229] },
  addons: { pet: 30, stain: 40, lights: 60, engine: 35 },
  memberAddonDiscount: 0.10,
  zones: [{ max: 12, fee: 0 }, { max: 20, fee: 15 }, { max: 30, fee: 30 }]
};

// NJ sales tax. Every price on the site is before tax; the tax is added to the customer's bill and shown on its own line.
// Taxed: packages, add-ons, travel fees and membership charges. Not taxed: tips and cancellation fees (Nick's call, Nov 2).
// The website has the same rate and rounding (taxCents in public/index.html) so estimates match to the cent.
export const TAX = { name: "NJ sales tax", rate: 0.06625, pct: "6.625%" };
const TAX_UNITS = Math.round(TAX.rate * 100000);   // 6625 (exact integer math, rounded half up to the cent)
export const taxCents = c => (c > 0 ? Math.floor((Math.round(c) * TAX_UNITS + 50000) / 100000) : 0);
export const withTax = c => { const t = taxCents(c); return { sub: Math.round(c), tax: t, total: Math.round(c) + t }; };

export function travelFee(miles) {
  if (miles == null || !isFinite(miles)) return 0;
  for (const z of PRICING.zones) if (miles <= z.max) return z.fee;
  return null;   // too far
}

// returning = this customer has booked before (launch price is for the first detail only)
// subtotal (dollars) is before tax; tax and total (with tax) are dollars with cents
export function quote({ pkg, size, adds, miles, returning, member }) {
  const table = !returning && PRICING.launchSale ? PRICING.launch : PRICING.regular;
  const base = table[pkg][size];
  const addTotal = (adds || []).reduce((t, id) => t + (member ? Math.round(PRICING.addons[id] * (1 - PRICING.memberAddonDiscount)) : PRICING.addons[id] || 0), 0);
  const travel = travelFee(miles) || 0;
  const subtotal = base + addTotal + travel, t = withTax(subtotal * 100);
  return { base, addTotal, travel, subtotal, tax: t.tax / 100, total: t.total / 100, launch: table === PRICING.launch, regular: PRICING.regular[pkg][size] };
}
