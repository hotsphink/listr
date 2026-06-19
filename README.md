# Listr, the list app with the stupid name =

## Running

### Client

Run the client from https://sphink.github.io/listr/ or run your own from the
checkout containing this README.md by running `pnpm preview`.

This will give you full local capabilities. You can, like, make lists and stuff.
Data will be stored in your browser's IndexedDB storage.

### Server

If you would like to access your lists across multiple devices, you will need a
sync server. The same server provides import capabilities, so you can give it
screenshots to pass through an AI to generate more list items or whole lists. I
used this to import my lists from a popular list management app by taking
screenshots of a pageful of items at a time. (It had an export capability, but
it was broken.) In theory, it could import lists from scraps of paper. I haven't
tried this.

#### Hosted

I run a sync server, and at the moment all you'd need to do to talk to it is
select the Sync button in the lower-left corner, add a server, and enter its
URL. Then make up a sync key and enter the same key on all devices. I will give
more instructions here once I add access control, because I don't want to pay
for all of your AI use nor do I want to have your unencrypted data sitting in my
DB. I don't know you. Who the hell are you, anyway? How well do you know
yourself?

#### Self-serve

Alternatively, you can run your own sync server. The easiest way would be to run
(in a checkout of the repository containing this README.md)

    cd packages/server
    pnpm dev

But then you'll have to figure out how to make that available from whatever
network your devices are on, possibly the public internet, and at this point
I'll remind you that I haven't implemented access controls yet. Feel free to
implement them yourself, and also implement whatever additional list-munging
magic you'd like on your very own sync server. Your server could be awesome. It
could maintain a list of the expected weather for the next 10 days. It could
maintain a master list of the lists of everyone else on the same server (but
don't make it creepy). It could do superintelligent CRDT-based synchronization
and merging of a globally distributed network of lists of, I don't know, anime
episodes or something. You figure it out, it's your server. Though the basic
sync server here should be fine; if you're doing all of that fancy stuff, why
are you even using my crappy software?

To hook up to a server, use the Sync button in the bottom left, which will bring
up the admin interface. You'll need to enter the hostname and port of your
server, however you need to get to it from where you are. You can even have
multiple options, depending on which network you're on, and it'll try all of
them until it gets through one. (Servers have IDs; if you're accidentally
switching to a different server, it'll warn you before doing it.)

You also need to make up a key. Clients accessing a sync server will sync with
the lists associated with that key. If you only want to access your own lists
from multiple devices, I guess you could use your name or something. I used
"kablaggle!" (not really, but the same idea.) You could share lists with other
people by using the same key. Currently, the key is global to the client, so you
can't have a mixture of private and shared lists. Hm, that sounds kind of cool,
maybe I'll change that.
