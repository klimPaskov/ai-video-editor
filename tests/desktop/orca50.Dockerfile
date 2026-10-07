FROM ai-video-editor-desktop:p1-accessibility
USER root
RUN apt-get update && apt-get install -y --no-install-recommends meson ninja-build pkg-config gcc libglib2.0-dev libdbus-1-dev libxtst-dev libxi-dev libxml2-dev gobject-introspection libgirepository1.0-dev python-gi-dev python3-dasbus gettext itstool libxml2-utils && rm -rf /var/lib/apt/lists/*
USER node
