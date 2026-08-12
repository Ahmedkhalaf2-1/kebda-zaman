/** The two non-customer, non-admin roles this admin-only module can create/manage. */
export const STAFF_ROLES = ['CASHIER', 'KITCHEN'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
