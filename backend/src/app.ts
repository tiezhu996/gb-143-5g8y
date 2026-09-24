import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import volunteerRoutes from './routes/volunteers';
import serviceRecordRoutes from './routes/serviceRecords';
import rankingRoutes from './routes/ranking';
import complaintRoutes from './routes/complaints';
import adminRoutes from './routes/admin';
import { authMiddleware } from './middleware/auth';
import { env } from './config/env';
import { messages } from './constants/messages';
import { badgeLevels, serviceRules, serviceTypes } from './constants/serviceConfig';
import { logger } from './utils/logger';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: messages.service.name,
    version: messages.service.version,
  });
});

app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: messages.service.name,
    version: messages.service.version,
  });
});

app.get('/api/v1/service-types', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      serviceTypes,
      badgeLevels,
      pointsPerHour: serviceRules.pointsPerHour,
      creditLimitThreshold: serviceRules.creditLimitThreshold,
    },
  });
});

app.use('/api/v1/volunteers', authMiddleware, volunteerRoutes);
app.use('/api/v1/service-records', authMiddleware, serviceRecordRoutes);
app.use('/api/v1/ranking', authMiddleware, rankingRoutes);
app.use('/api/v1/complaints', authMiddleware, complaintRoutes);
app.use('/api/v1/admin', authMiddleware, adminRoutes);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(messages.errors.unhandled, err);
  res.status(500).json({
    success: false,
    error: messages.errors.internal,
  });
});

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: messages.errors.notFound,
    path: req.path,
  });
});

export default app;
