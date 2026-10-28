/** The injection token for the shared Redis connection. Its own file, so the
 * module and the services it provides can both import it without a cycle. */
export const REDIS = Symbol('OOLIX_REDIS');
