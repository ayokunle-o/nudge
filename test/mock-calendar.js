// Stand-in for the phone calendar, used only by the browser test build.
const day = new Date(); day.setHours(0, 0, 0, 0);
const at = (h, m = 0, d = 0) => day.getTime() + d * 86400e3 + (h * 60 + m) * 60e3;
const store = (window.__cal = {
  events: [
    { id: '1', calendarId: 'w1', title: 'Team standup', startDate: at(23, 50), endDate: at(23, 59), isAllDay: false, description: '', location: 'Google Meet' },
    { id: '2', calendarId: 'p1', title: 'Dinner with Toluwani', startDate: at(19), endDate: at(21), isAllDay: false, description: '' },
    { id: '3', calendarId: 'w1', title: 'Client review', startDate: at(10, 0, 1), endDate: at(11, 0, 1), isAllDay: false, description: '' },
  ].filter((e) => e.endDate > Date.now() || e.id === '3'),
  log: [], nextId: 100,
});
export const CapacitorCalendar = {
  async requestFullCalendarAccess() { return { result: 'granted' }; },
  async listCalendars() { return { result: [
    { id: 'w1', title: 'work@studio.com', accountName: 'work@studio.com', color: '#3d5a99', allowsContentModifications: true },
    { id: 'p1', title: 'stephenheryour@gmail.com', accountName: 'stephenheryour@gmail.com', color: '#c8502a', allowsContentModifications: true },
    { id: 'h1', title: 'Holidays in Nigeria', accountName: 'stephenheryour@gmail.com', color: '#2f6f5e', allowsContentModifications: false },
  ] }; },
  async getDefaultCalendar() { return { result: { id: 'cal1', title: 'stephen@gmail.com' } }; },
  async listEventsInRange({ from, to }) { return { result: store.events.filter((e) => e.endDate > from && e.startDate < to) }; },
  async createEvent(o) { const id = String(store.nextId++); store.events.push({ ...o, id, isAllDay: false }); store.log.push(['create', id, o.title, o.calendarId]); return { id, ics: null }; },
  async modifyEvent(o) { const e = store.events.find((x) => x.id === o.id); if (!e) throw new Error('nope'); Object.assign(e, o); store.log.push(['modify', o.id, o.title, o.startDate]); },
  async deleteEvent({ id }) { store.events = store.events.filter((x) => x.id !== id); store.log.push(['delete', id]); },
};
