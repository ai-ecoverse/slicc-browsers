package sliccbrowsers

import _ "embed"

//go:embed lease-v1.json
var leaseV1JSON string

//go:embed lease-scope-v1.json
var leaseScopeV1JSON string

//go:embed schema/lease-v1.schema.json
var leaseV1SchemaJSON string

func LeaseV1JSON() []byte { return []byte(leaseV1JSON) }

func LeaseScopeV1JSON() []byte { return []byte(leaseScopeV1JSON) }

func LeaseV1SchemaJSON() []byte { return []byte(leaseV1SchemaJSON) }
