#!/bin/sh
# People tapping badges at the kiosk: about one a second.
while true; do wget -q -O- "$TARGET" >/dev/null 2>&1; sleep 1; done
