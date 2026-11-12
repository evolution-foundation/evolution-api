# patches/

`patch-package` patches for third-party dependencies. They are applied by the
`postinstall` hook (`package.json`) and re-applied inside the Docker builder,
which copies this directory before `npm ci` (`COPY ./patches ./patches`).

Keep this directory tracked even when there is no patch: removing it breaks the
Docker build, since the `COPY` above cannot resolve a path that does not exist.
