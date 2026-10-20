const fields = (value) => {
  if (!value || typeof value !== 'object') return [];
  return [
    ...(typeof value.urlFragment === 'string' ? [value] : []),
    ...Object.values(value).flatMap(fields),
  ];
};

export function redirectFragments({ messages, events, replies, protectedOrigins, contains }) {
  const protectedURL = (text) => {
    try {
      return protectedOrigins.includes(new URL(text).origin);
    } catch {
      return false;
    }
  };
  const visible = (value) =>
    fields(value).some((field) => field.urlFragment !== '' && contains(field.urlFragment));
  const reply = (method) =>
    replies.filter((entry) => entry.method === method).map((entry) => entry.result);
  return {
    fragmentsHidden: messages
      .flatMap((message) => fields(JSON.parse(message)))
      .every(
        (field) =>
          (!protectedURL(field.url) && !protectedURL(field.unreachableUrl)) ||
          field.urlFragment === ''
      ),
    networkFragmentVisible: events.some(
      (event) => event.method === 'Network.requestWillBeSent' && visible(event.params.request)
    ),
    frameFragmentVisible: events.some(
      (event) => event.method === 'Page.frameNavigated' && visible(event.params.frame)
    ),
    frameTreeFragmentVisible: visible(reply('Page.getFrameTree')),
    resourceTreeFragmentVisible: visible(reply('Page.getResourceTree')),
  };
}
