/**
 * Shared USD formatter. OverviewTab and CostRollup used to each construct
 * their own `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`
 * — harmless while both hardcode USD, but two copies is how a future
 * multi-currency change (see docs/BACKLOG.md) would end up updating one and
 * missing the other.
 */
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(cents: number): string {
  return money.format(cents / 100);
}
