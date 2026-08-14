#!/bin/sh
# Stands in for `tmux display -p '#{client_termfeatures}'` on a client whose
# terminal-features advertise sixel, so tmux 3.4+ owns the raster itself.
echo "bpaste,ccolour,clipboard,cstyle,focus,RGB,sixel,title"
