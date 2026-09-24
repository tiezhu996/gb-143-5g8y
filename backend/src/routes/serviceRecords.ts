import { Router, Request, Response } from 'express';
import { validateRequest, validateQuery, serviceRecordSchema, batchServiceRecordsSchema, paginationSchema } from '../middleware/validator';
import { AuthRequest } from '../middleware/auth';
import {
  createServiceRecord,
  batchCreateServiceRecords,
  getVolunteerServiceRecords,
  getServiceRecordById,
  deleteServiceRecord,
} from '../services/volunteerService';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

router.post('/', validateRequest(serviceRecordSchema), async (req: Request, res: Response) => {
  try {
    const result = await createServiceRecord(req.body);
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating service record');
  }
});

router.post('/batch', validateRequest(batchServiceRecordsSchema), async (req: Request, res: Response) => {
  try {
    const result = await batchCreateServiceRecords(req.body.records);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error batch creating service records');
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await getServiceRecordById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting service record');
  }
});

router.get('/volunteer/:volunteerId', validateQuery(paginationSchema), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const result = await getVolunteerServiceRecords(req.params.volunteerId, page, pageSize);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting volunteer service records');
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'anonymous';
    const reason = req.query.reason as string || '管理员删除';
    const result = await deleteServiceRecord(req.params.id, adminId, reason);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error deleting service record');
  }
});

export default router;
