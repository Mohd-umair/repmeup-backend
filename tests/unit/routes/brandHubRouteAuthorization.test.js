/**
 * Regression guard for the "super_admin gets 403 managing Brand Hub" bug.
 *
 * `super_admin` is a distinct role value from `admin` (see backend/src/models/User.js
 * role enum) — Express's authorize(...roles) middleware only matches an EXACT
 * role string, so any authorize() call that lists 'admin'/'manager' but forgets
 * 'super_admin' silently 403s super-admin users. This test does not hit any
 * route over HTTP; instead it requires each route file fresh (via
 * jest.isolateModules) with `authorize` mocked to record exactly which roles
 * array every call site was wired with, then asserts 'super_admin' is present
 * on every one — so this fails loudly the moment someone adds a new brand-hub
 * mutation route without it, instead of silently shipping a 403 to production.
 */

/**
 * @param {string} routePath - path to the route file, relative to backend/src/routes
 * @param {Record<string, string[]>} controllerMocks - module path → method names to stub
 * @returns {string[][]} the `roles` array passed to every authorize(...) call, in file order
 */
function captureAuthorizeCalls(routePath, controllerMocks) {
  const capturedRoles = [];
  jest.isolateModules(() => {
    jest.doMock('../../../src/middlewares/auth', () => ({
      protect: (req, res, next) => next(),
      authorize: (...roles) => {
        capturedRoles.push(roles);
        return (req, res, next) => next();
      }
    }));
    for (const [modPath, methods] of Object.entries(controllerMocks)) {
      jest.doMock(modPath, () => {
        const stub = {};
        for (const m of methods) stub[m] = jest.fn((req, res) => res.status(200).json({ success: true }));
        return stub;
      });
    }
    require(routePath);
  });
  return capturedRoles;
}

describe('Brand Hub route authorization wiring', () => {
  test('brandConfig.js: every mutating route authorizes super_admin + admin + manager', () => {
    const calls = captureAuthorizeCalls('../../../src/routes/brandConfig.js', {
      '../../../src/controllers/brandConfigController': [
        'getBrandConfig', 'getPreview', 'updateBrandConfig', 'retrainVoice',
        'analyzeBrandProfile', 'updateProfileOverrides', 'clearBrandProfile'
      ],
      '../../../src/controllers/brandReferenceImageController': [
        'list', 'styleSummary', 'upload', 'reAnalyzeAll', 'update', 'remove'
      ]
    });

    // 9 authorize() call sites: PUT /, POST /retrain, POST /analyze,
    // PUT /profile-overrides, DELETE /brand-profile (5) + POST/POST-re-analyze/
    // PUT/DELETE reference-images (4). Update this count deliberately if a
    // route is added/removed, not by accident.
    expect(calls.length).toBe(9);
    for (const roles of calls) {
      expect(roles).toEqual(expect.arrayContaining(['super_admin', 'admin', 'manager']));
    }
  });

  test('eventTemplates.js: every mutating route authorizes super_admin + admin + manager', () => {
    const calls = captureAuthorizeCalls('../../../src/routes/eventTemplates.js', {
      '../../../src/controllers/eventTemplateController': ['list', 'create', 'update', 'remove']
    });

    expect(calls.length).toBe(3); // POST /, PUT /:id, DELETE /:id
    for (const roles of calls) {
      expect(roles).toEqual(expect.arrayContaining(['super_admin', 'admin', 'manager']));
    }
  });

  test('inspirations.js: add-to-references authorizes super_admin + admin + manager', () => {
    const calls = captureAuthorizeCalls('../../../src/routes/inspirations.js', {
      '../../../src/controllers/inspirationController': ['list', 'addToReferences']
    });

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['super_admin', 'admin', 'manager']));
  });
});
