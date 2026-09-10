/**
 * @oolix/db -- the single owner of the Oolix control-plane schema.
 *
 * The API gateway and the worker both need database access, so the generated
 * Prisma client lives in one package rather than being reached into across app
 * boundaries. §61 asks for "strong module/data ownership so services can be
 * split later"; sharing the client is what makes that split cheap.
 *
 * Consumers construct their OWN PrismaClient with their own pool size (§73
 * sets the API at 10 connections per pod and the worker at 5), so this package
 * exports the class and types, not a shared instance.
 */
export { PrismaClient, Prisma } from './generated/prisma/client.js';
export type * from './generated/prisma/models.js';
