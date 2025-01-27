# LNURL-NWC

This is a web application that allows to create LNURL strings and QR codes for NWC connections. 

It is completely stateless because the NWC connection string is encoded as part of the LNURL. Because of this it is important that only read-only NWC connections are used! 

## How to run it


### Development

```sh
$ deno task dev
```

### Production

```sh
$ deno task start
```

Also have a look at the Dockerfile to run it as a docker container. 



