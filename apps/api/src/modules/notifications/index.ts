// Public surface of the notifications module. Other modules import only from here.
export { notificationRoutes } from './routes.ts';
export {
  createNotificationService,
  type NotificationService,
  type NotificationView,
} from './service.ts';
export {
  insertNotifications,
  NOTIFICATION_TYPES,
  type NewNotification,
  type NotificationType,
} from './repository.ts';
