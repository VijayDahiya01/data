/**
 * Resolve NodeNext-style `.js` specifiers back to their TypeScript source.
 *
 * The app compiles to CommonJS but its imports carry an explicit `.js`
 * extension, so `./foo.js` has to find `foo.ts` under Jest. A blanket
 * moduleNameMapper that strips `.js` cannot be used: dependencies such as zod
 * ship CommonJS that uses the same specifier style, and rewriting THEIR
 * imports breaks them.
 *
 * So: try the request unchanged first, and only strip the extension when
 * nothing resolved. Third-party packages take the first path; our sources take
 * the second.
 */
module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (err) {
    if (/^\.{1,2}\//.test(request) && request.endsWith('.js')) {
      return options.defaultResolver(request.slice(0, -'.js'.length), options);
    }
    throw err;
  }
};
