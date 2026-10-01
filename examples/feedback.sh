#!/usr/bin/env bash
feedback=$(cat)

case $(jev match suggestion='a useful suggestion' bug='a bug report' day='someone having a day' <<<"$feedback") in
  suggestion) echo 'Added to the roadmap. A mythical place.' ;;
  bug)        echo 'That is, regrettably, our department.' ;;
  day)        echo 'We hear you. We are also having a day.' ;;
  *)          exit 2 ;;
esac
