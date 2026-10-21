import { Router } from 'express';
import { categoryParamsSchema, listCategoriesQuerySchema } from '@wayora/contracts';
import { notFound } from '../../utils/errors.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { CatalogService } from './catalog.service.js';

/**
 * GET /catalog/categories               – list travel categories (?availability=planned|beta|live)
 * GET /catalog/categories/:slug         – one category
 */
export function catalogRouter(service = new CatalogService()): Router {
  const router = Router();

  router.get('/categories', (req, res) => {
    const { query } = validateRequest(req, { query: listCategoriesQuerySchema });
    res.setHeader('Cache-Control', 'public, max-age=300');
    sendData(res, service.list(query));
  });

  router.get('/categories/:slug', (req, res) => {
    const { params } = validateRequest(req, { params: categoryParamsSchema });
    const category = service.get(params.slug);
    if (!category) throw notFound(`Category "${params.slug}" does not exist.`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    sendData(res, category);
  });

  return router;
}
