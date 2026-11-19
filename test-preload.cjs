// Provide stable user metadata when constrained environments cannot call uv_os_get_passwd.
const os = require('node:os'); // Load Node's operating-system helpers before the TypeScript runner starts.
os.userInfo = () => ({
  // Replace only userInfo for this local process; game and production behavior are unchanged.
  uid: -1, // Windows does not expose a POSIX user ID here.
  gid: -1, // Windows does not expose a POSIX group ID here.
  username: process.env.USERNAME || 'test-user', // Preserve the current account name when Windows provided one.
  homedir: process.env.USERPROFILE || process.cwd(), // Use the configured Windows profile as the home directory.
  shell: process.env.COMSPEC || '', // Keep a valid shell string for tools that inspect user information.
}); // Finish the test-only fallback.
