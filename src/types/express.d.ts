/**
 * Augments Express's Request with the fields our auth middleware attaches:
 *  - userId/userEmail: set by `authenticate` after verifying the Supabase JWT.
 *  - storeId/storeRole: set by `requireStore` after looking up store_members.
 */
declare namespace Express {
  export interface Request {
    userId?: string;
    userEmail?: string;
    storeId?: string;
    storeRole?: "owner" | "keeper";
  }
}
