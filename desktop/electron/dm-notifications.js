const PRIVATE_NOTIFICATION_BODY = '收到一条新私信';
const APP_TITLE = 'Vulcan抖音控制台';
const TITLE_MAX_LENGTH = 48;
const BODY_MAX_LENGTH = 120;

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function compactText(value, maxLength) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function isQuietTime(settings, date) {
  const start = parseClock(settings?.quiet_hours_start);
  const end = parseClock(settings?.quiet_hours_end);
  if (start === null || end === null || start === end) return false;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;

  const current = (date.getHours() * 60) + date.getMinutes();
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function isNotifiableMessage(message) {
  return Boolean(
    message
    && normalizeRequiredString(message.accountId)
    && normalizeRequiredString(message.conversationId)
    && message.direction === 'inbound'
    && message.messageType === 'text'
    && compactText(message.content, BODY_MAX_LENGTH),
  );
}

function createDmNotifier({ NotificationClass, showWindow, sendNavigation, now } = {}) {
  const notifiedMessageIds = new Set();
  const getNow = typeof now === 'function' ? now : () => new Date();
  const restoreWindow = typeof showWindow === 'function' ? showWindow : () => false;
  const navigate = typeof sendNavigation === 'function' ? sendNavigation : () => {};

  function notificationsSupported() {
    if (typeof NotificationClass !== 'function') return false;
    try {
      return typeof NotificationClass.isSupported !== 'function' || NotificationClass.isSupported();
    } catch {
      return false;
    }
  }

  function notify(message, settings = {}) {
    if (settings.notifications_enabled !== true || !isNotifiableMessage(message)) return false;
    if (isQuietTime(settings, getNow())) return false;
    if (!notificationsSupported()) return false;

    const accountId = normalizeRequiredString(message.accountId);
    const conversationId = normalizeRequiredString(message.conversationId);
    const messageId = normalizeRequiredString(message.id);
    if (messageId && notifiedMessageIds.has(messageId)) return false;

    const previewEnabled = settings.notification_preview === true;
    const peerName = compactText(message.peerName || '新联系人', TITLE_MAX_LENGTH - 6);
    const notificationOptions = previewEnabled
      ? {
        title: compactText(`${peerName || '新联系人'} 发来私信`, TITLE_MAX_LENGTH),
        body: compactText(message.content, BODY_MAX_LENGTH),
      }
      : {
        title: APP_TITLE,
        body: PRIVATE_NOTIFICATION_BODY,
      };

    try {
      const notification = new NotificationClass(notificationOptions);
      if (!notification || typeof notification.show !== 'function') return false;
      if (typeof notification.on === 'function') {
        notification.on('click', () => {
          try {
            if (restoreWindow() === false) return;
            navigate({ accountId, conversationId });
          } catch {
            // Notification interaction must not affect the monitor loop.
          }
        });
      }
      notification.show();
      if (messageId) notifiedMessageIds.add(messageId);
      return true;
    } catch {
      return false;
    }
  }

  return { notify };
}

module.exports = {
  createDmNotifier,
};
