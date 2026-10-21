import { Router, type RequestHandler } from 'express';
import {
  createTravellerRequestSchema,
  travellerParamsSchema,
  updateProfileRequestSchema,
  updateTravellerRequestSchema,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth } from '../../middleware/session.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { toSafeUser } from '../auth/safe-user.js';
import type { UsersService } from './users.service.js';

/**
 * All routes require a session; identity comes from it alone.
 *
 * GET    /users/me                              the signed-in user's profile
 * PATCH  /users/me                              update permitted fields (name)
 * GET    /users/me/travellers                   list saved travellers
 * POST   /users/me/travellers                   add one                       201
 * PATCH  /users/me/travellers/:travellerId      edit one of *your* travellers
 * DELETE /users/me/travellers/:travellerId      delete one of *your* travellers
 */
export function usersRouter(users: UsersService): Router {
  const router = Router();
  router.use(noStore, requireAuth);

  router.get('/me', (_req, res) => {
    sendData(res, toSafeUser(currentUser(res)));
  });

  router.patch('/me', (async (req, res) => {
    const { body } = validateRequest(req, { body: updateProfileRequestSchema });
    sendData(res, await users.updateProfile(currentUser(res).id, body));
  }) satisfies RequestHandler);

  router.get('/me/travellers', (async (_req, res) => {
    sendData(res, await users.listTravellers(currentUser(res).id));
  }) satisfies RequestHandler);

  router.post('/me/travellers', (async (req, res) => {
    const { body } = validateRequest(req, { body: createTravellerRequestSchema });
    sendData(res, await users.createTraveller(currentUser(res).id, body), 201);
  }) satisfies RequestHandler);

  router.patch('/me/travellers/:travellerId', (async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: travellerParamsSchema,
      body: updateTravellerRequestSchema,
    });
    sendData(res, await users.updateTraveller(currentUser(res).id, params.travellerId, body));
  }) satisfies RequestHandler);

  router.delete('/me/travellers/:travellerId', (async (req, res) => {
    const { params } = validateRequest(req, { params: travellerParamsSchema });
    await users.deleteTraveller(currentUser(res).id, params.travellerId);
    sendData(res, { id: params.travellerId, deleted: true });
  }) satisfies RequestHandler);

  return router;
}
