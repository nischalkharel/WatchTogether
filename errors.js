// An error with an HTTP status and a short code the page can show a message for.
export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Plain-language messages for errors shown to people.
export const MESSAGES = {
  'sign-in-required': 'Please sign in first.',
  'not-linked': 'Link with your partner first.',
  'empty-message': 'Type a message first.',
  'long-message': 'That message is too long (500 characters at most).',
  'history-missing': 'That was already removed from your history.',
  'bad-playlist-name': 'Please give the playlist a name.',
  'too-many-playlists': 'You have the most playlists allowed (50). Delete one first.',
  'playlist-missing': 'That playlist no longer exists.',
  'playlist-full': 'That playlist is full (500 videos).',
  'already-in-playlist': 'That video is already in this playlist.',
  'item-missing': 'That video was removed from the playlist.',
  'bad-video': 'That doesn’t look like a YouTube video.',
  'proposal-gone': 'That suggestion was already answered or replaced.',
  'own-proposal': 'Your partner needs to accept your suggestion.',
  'bad-request': 'Something went wrong. Please try again.',
  'bad-origin': 'That request came from another website and was blocked.',
  'bad-csrf': 'Your page is out of date. Please reload and try again.',
  'too-many': 'Too many attempts. Please wait a minute and try again.',
  'bad-name': 'Please enter a name.',
  'bad-account': 'Google did not send a usable account.',
  'already-linked': 'You are already linked with a partner. Unlink first to link with someone else.',
  'partner-linked': 'That person has already linked with someone else.',
  'invite-invalid': 'This invite link has expired, was already used, or was cancelled. Ask your partner for a new one.',
  'own-invite': 'This is your own invite link. Send it to your partner instead.',
  'request-invalid': 'That link request has expired or was cancelled.',
  'confirm-mismatch': 'Type DELETE to confirm.',
  'no-account': 'This account no longer exists.',
  'not-found': 'Not found.',
  unavailable: 'Google sign-in isn’t set up on this server. Use a username and password instead.',
  'bad-username': 'Usernames are 3–30 letters, numbers, dots, dashes or underscores.',
  'username-taken': 'That username is taken. Try another.',
  'weak-password': 'Use at least 10 characters. A few random words works well.',
  'common-password': 'That password is too easy to guess. Try something less common.',
  'bad-password': 'That password is too long.',
  'bad-login': 'Wrong username or password.',
  'wrong-password': 'Your current password is wrong.',
  'no-password': 'This account signs in with Google and has no password.',
};
