/**
 * Unit tests for the `authorize` role-gate middleware (backend/src/middlewares/auth.js).
 *
 * This is the primitive every Brand Hub mutation route relies on — see
 * brandHubRouteAuthorization.test.js for the regression guard that checks
 * every Brand Hub route actually calls it with the right roles.
 */
const { authorize } = require('../../../src/middlewares/auth');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('authorize()', () => {
  test('401s when req.user is missing (protect() did not run / token invalid)', () => {
    const mw = authorize('admin', 'manager');
    const req = {};
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('403s when req.user.role is not in the allowed list', () => {
    const mw = authorize('admin', 'manager');
    const req = { user: { role: 'agent' } };
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.stringContaining("'agent'")
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when req.user.role is in the allowed list', () => {
    const mw = authorize('super_admin', 'admin', 'manager');
    const next = jest.fn();
    for (const role of ['super_admin', 'admin', 'manager']) {
      next.mockClear();
      const res = mockRes();
      mw({ user: { role } }, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  test("'admin' alone does NOT implicitly grant 'super_admin' — they are distinct role values " +
    '(see User.js role enum); every authorize() call site must list both explicitly', () => {
    const mw = authorize('admin', 'manager'); // deliberately missing super_admin
    const req = { user: { role: 'super_admin' } };
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
