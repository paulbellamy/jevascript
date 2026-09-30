#!/usr/bin/env bash
message=$(cat)

case $(jev feels -c 80 'genuinely urgent' <<<"$message") in
  yes)   echo 'Okay. This is a drop-everything situation.' ;;
  maybe) echo 'Define urgent. And define tiny favor.' ;;
  no)    echo 'This could have been an email. Oh, it is.' ;;
  *)     exit 2 ;;
esac
