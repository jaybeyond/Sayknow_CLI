#!/bin/sh
# Stands in for `tmux display -p '#{client_termfeatures}'` on a client whose
# terminal-features do NOT advertise sixel: tmux cannot record a raster it
# never parsed, so it can neither position nor erase one.
echo "bpaste,ccolour,clipboard,cstyle,focus,RGB,title"
