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

export function travelFee(miles) {
  if (miles == null || !isFinite(miles)) return 0;
  for (const z of PRICING.zones) if (miles <= z.max) return z.fee;
  return null;   // too far
}

// returning = this customer has booked before (launch price is for the first detail only)
export function quote({ pkg, size, adds, miles, returning, member }) {
  const table = !returning && PRICING.launchSale ? PRICING.launch : PRICING.regular;
  const base = table[pkg][size];
  const addTotal = (adds || []).reduce((t, id) => t + (member ? Math.round(PRICING.addons[id] * (1 - PRICING.memberAddonDiscount)) : PRICING.addons[id] || 0), 0);
  const travel = travelFee(miles) || 0;
  return { base, addTotal, travel, total: base + addTotal + travel, launch: table === PRICING.launch, regular: PRICING.regular[pkg][size] };
}
