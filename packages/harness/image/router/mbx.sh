#!/bin/sh
# The router of a middlebox chain: one image for the forms of a middlebox at its idle expiry.
#
#   FORM=reset-both|reset-next|silent-drop|recreate|none IDLE=<seconds> [LAN=eth0] [WAN=eth1] [PUMP=0.1] [SLOW=0.02]
#
# The container is privileged, so it sets the sysctls of its own namespace. Docker Desktop keeps
# /proc/sys read-only in a container that is not. The network of the side of the client is LAN,
# and the harness connects the network of the side of the target (WAN) after the start.
#
# FORM         at the expiry                  a late packet from inside      a late packet from outside
# reset-both   a reset to the two ends        dropped                        dropped
# reset-next   nothing                        a reset to its sender          dropped
# silent-drop  nothing                        dropped                        dropped
# recreate     nothing                        passes, and starts the flow    dropped
# none         nothing                        passes (a plain NAT router)    a reset from the router
#
# A lookup treats an expired entry as gone, so the router forgets a flow at its timeout to the
# jiffy. The DESTROY event of conntrack waits for the garbage collector or a lookup: ctwatch.py
# lists the table every PUMP seconds, so the event follows the expiry within PUMP and two listings.
# A listing longer than SLOW seconds writes a pump-slow line: near it, that bound does not hold.
set -eu
FORM=${FORM:-none}; LAN=${LAN:-eth0}; WAN=${WAN:-eth1}; PUMP=${PUMP:-0.1}; SLOW=${SLOW:-0.02}; IDLE=${IDLE:-432000}
sysctl -q -w net.ipv4.ip_forward=1
# the conntrack sysctls of a namespace appear when it first uses conntrack: a listing does that
conntrack -L >/dev/null 2>&1 || true
sysctl -q -w net.netfilter.nf_conntrack_events=1
sysctl -q -w "net.netfilter.nf_conntrack_tcp_timeout_established=$IDLE"
i=0
while ! ip link show "$WAN" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 600 ] && { echo "mbx: no $WAN" >&2; exit 65; }; sleep 0.1
done
case $FORM in
  reset-both)  INSIDE=drop; OUTSIDE=drop ;;
  reset-next)  INSIDE=rst;  OUTSIDE=drop ;;
  silent-drop) INSIDE=drop; OUTSIDE=drop ;;
  recreate)    INSIDE=pass; OUTSIDE=drop ;;
  none)        INSIDE=pass; OUTSIDE=rst ;;
  *) echo "mbx: unknown FORM=$FORM" >&2; exit 64 ;;
esac
verdict() { case $1 in rst) echo "reject with tcp reset" ;; drop) echo drop ;; *) echo accept ;; esac; }
# OUTSIDE=rst: accept, and the stack of the router answers the unknown port with an exact reset
outv=$(verdict "$OUTSIDE"); [ "$OUTSIDE" = rst ] && outv=accept
nft -f - <<EOF
table ip mbx {
  chain mbx_post { type nat hook postrouting priority srcnat; policy accept; oifname "$WAN" masquerade; }
  chain mbx_fwd {
    type filter hook forward priority filter; policy accept;
    iifname "$LAN" meta l4proto tcp ct state new,invalid tcp flags & (syn|ack) != syn counter $(verdict "$INSIDE")
  }
  chain mbx_in {
    type filter hook input priority filter; policy accept;
    iifname "$WAN" meta l4proto tcp ct state new,invalid tcp flags & (syn|ack) != syn counter $outv
  }
}
EOF
echo "{\"ev\":\"mbx-ready\",\"t\":0,\"form\":\"$FORM\",\"idle\":$(cat /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established),\"inside\":\"$INSIDE\",\"outside\":\"$OUTSIDE\"}"
if [ "$FORM" = reset-both ]; then
  python3 /opt/mbx/ctwatch.py --pump "$PUMP" --slow "$SLOW" &
  exec python3 /opt/mbx/resetter.py "$LAN" "$WAN"
fi
exec python3 /opt/mbx/ctwatch.py --pump "$PUMP" --slow "$SLOW"
