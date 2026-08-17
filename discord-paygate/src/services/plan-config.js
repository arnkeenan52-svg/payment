// Effective plan configuration: plans.json is the shipped default, but the
// role mapping can be overridden at runtime from the owner diagnostics page
// (stored in the database — the deployed filesystem is read-only). Pricing
// and billing fields (stripePriceId, priceUsd, lifetime, durationDays) are
// deliberately NOT runtime-editable; only the Discord role mapping is.

import { config, planById, managedRoleIds } from '../config.js';
import { getAllPlanOverrides, getPlanOverride } from '../db.js';

export async function effectiveRoleIds(planId) {
  const override = await getPlanOverride(planId);
  return override?.roleIds ?? planById(planId)?.roleIds ?? [];
}

// Map of planId -> { roleIds, roleNames } merged over the static catalog.
export async function effectiveRoleMap() {
  const overrides = await getAllPlanOverrides();
  const map = new Map();
  for (const plan of config.plans) {
    const o = overrides.get(plan.id);
    map.set(plan.id, {
      roleIds: o?.roleIds ?? plan.roleIds,
      roleNames: o?.roleNames ?? plan.roleNames ?? [],
      source: o ? 'override' : 'default',
    });
  }
  return map;
}

// Every role id the reconciler may remove: static plans.json ids plus every
// override — so a role that was mapped in the past is still cleaned up after
// the mapping changes.
export async function effectiveManagedRoleIds() {
  const managed = managedRoleIds();
  for (const { roleIds } of (await getAllPlanOverrides()).values()) {
    for (const id of roleIds) managed.add(id);
  }
  return managed;
}
