# Listr, the list app with the stupid name =

## Running

### Client

Run the client from https://sphink.github.io/listr/ or run your own from the
checkout containing this README.md by running `pnpm preview`.

This will give you full local capabilities. You can, like, make lists and stuff.
Data will be stored in your browser's IndexedDB storage.

#### Building

`pnpm build` produces a production build in `packages/client/dist/`. This is
what gets deployed to GitHub Pages and is safe to publish — the service worker
uses a stable cache key so repeat deploys don't force unnecessary client
updates.

`pnpm build:deploy` (in `packages/client`) builds for production but also
stamps the service worker with the current timestamp, so the browser detects
a new version and updates immediately on the next page load. Use this when
you want to test PWA behaviour — icon changes, `start_url`, offline caching —
without waiting for the browser to notice a cache miss on its own. Because the
PWA icon is set at install time by the OS, you still need to uninstall and
re-add the app after changing icons, but at least the new manifest will be
live and fresh when you do.

Non-production builds (`pnpm build --mode staging`, etc.) stamp the service
worker automatically.

### Server

If you would like to access your lists across multiple devices, you will need a
sync server. The same server provides import capabilities, so you can give it
screenshots to pass through an AI to generate more list items or whole lists. I
used this to import my lists from a popular list management app by taking
screenshots of a pageful of items at a time. (It had an export capability, but
it was broken.) In theory, it could import lists from scraps of paper. I haven't
tried this.

#### Hosted

I run a sync server. There is no self-signup, so you will need a join link from
me before it will talk to you. Once you have one, select the Sync button in the
lower-left corner, add the server, and open the link.

Why no self-signup? I don't want to pay for all of your AI use, nor do I want
to have your unencrypted data sitting in my DB. I don't know you. Who the hell
are you, anyway? How well do you know yourself?

#### Self-serve

Alternatively, you can run your own sync server. Start with

    cd packages/server
    pnpm dev

and see
[packages/server/README.md](https://github.com/hotsphink/listr/blob/main/packages/server/README.md)
for configuring it, getting the first user in, and handing out accounts.

#### Connecting

To hook up to a server, use the Sync button in the bottom left, which will bring
up the admin interface. You'll need to enter the hostname and port of your
server, however you need to get to it from where you are. You can even have
multiple options, depending on which network you're on, and it'll try all of
them until it gets through one. (Servers have IDs; if you're accidentally
switching to a different server, it'll warn you before doing it.)

The first time you connect, the client makes itself a keypair and the server
has to be told to expect it, which is what the join link does. After that the
device is known and just reconnects.

You no longer have to make up a key. Older versions had you invent a shared
secret and type it into every device; that was the whole access control story,
and it was not much of one. Now the server assigns each user a private sync key
of its own and hands it to your clients during the handshake, and boards you
share with other people get their own keys on top of that. So you can have a
mixture of private and shared lists, which I said sounded kind of cool, and it
turns out it is.
