import { Router, Request, Response } from 'express';
import { validateRequest, validateQuery, complaintSchema, handleComplaintSchema, paginationSchema } from '../middleware/validator';
import {
  createComplaint,
  getComplaints,
  handleComplaint,
  getComplaintById,
} from '../services/complaintService';
import { AuthRequest } from '../middleware/auth';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

router.post('/', validateRequest(complaintSchema), async (req: Request, res: Response) => {
  try {
    const result = await createComplaint(
      req.body.volunteer_id,
      req.body.complaint_type,
      req.body.description,
      req.body.complainant_id
    );
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating complaint');
  }
});

router.get('/', validateQuery(paginationSchema), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const status = req.query.status as string;
    const volunteerId = req.query.volunteer_id as string;
    const result = await getComplaints(page, pageSize, status, volunteerId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting complaints');
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await getComplaintById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting complaint');
  }
});

router.post('/:id/handle', validateRequest(handleComplaintSchema), async (req: AuthRequest, res: Response) => {
  try {
    const handledBy = req.user?.id || 'admin';
    const result = await handleComplaint(
      req.params.id,
      req.body.action,
      handledBy,
      req.body.resolution,
      req.body.severity
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error handling complaint');
  }
});

export default router;
