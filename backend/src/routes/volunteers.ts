import { Router, Request, Response } from 'express';
import { validateRequest, validateQuery, volunteerCreateSchema, volunteerUpdateSchema, paginationSchema } from '../middleware/validator';
import {
  createVolunteer,
  getVolunteerById,
  getVolunteers,
  updateVolunteer,
  toggleVolunteerActive,
  getVolunteerPointsLogs,
  getVolunteerCreditLogs,
  getVolunteerSummary,
} from '../services/volunteerManager';
import { getVolunteerBadges } from '../services/badgeService';
import { messages } from '../constants/messages';
import { sendBadRequest, sendInternalError } from '../utils/httpResponses';

const router = Router();

router.post('/', validateRequest(volunteerCreateSchema), async (req: Request, res: Response) => {
  try {
    const result = await createVolunteer(req.body.name, req.body.phone, req.body.email);
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating volunteer');
  }
});

router.get('/', validateQuery(paginationSchema), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const search = req.query.search as string;
    const result = await getVolunteers(page, pageSize, search);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting volunteers');
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await getVolunteerById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting volunteer');
  }
});

router.get('/:id/summary', async (req: Request, res: Response) => {
  try {
    const result = await getVolunteerSummary(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting volunteer summary');
  }
});

router.get('/:id/badges', async (req: Request, res: Response) => {
  try {
    const badges = await getVolunteerBadges(req.params.id);
    res.status(200).json({ success: true, data: badges });
  } catch (error) {
    sendInternalError(res, error, 'Error getting volunteer badges');
  }
});

router.get('/:id/points-logs', validateQuery(paginationSchema), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const result = await getVolunteerPointsLogs(req.params.id, page, pageSize);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting points logs');
  }
});

router.get('/:id/credit-logs', validateQuery(paginationSchema), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const result = await getVolunteerCreditLogs(req.params.id, page, pageSize);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting credit logs');
  }
});

router.put('/:id', validateRequest(volunteerUpdateSchema), async (req: Request, res: Response) => {
  try {
    const result = await updateVolunteer(req.params.id, req.body);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error updating volunteer');
  }
});

router.patch('/:id/status', async (req: Request, res: Response) => {
  try {
    const isActive = req.body.is_active;
    if (typeof isActive !== 'boolean') {
      sendBadRequest(res, messages.validation.activeFlagRequired);
      return;
    }
    const result = await toggleVolunteerActive(req.params.id, isActive);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error updating volunteer status');
  }
});

export default router;
